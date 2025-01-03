import { ChatPromptTemplate } from '@langchain/core/prompts'
import { LLMChain } from 'langchain/chains'
import { ChatAnthropic } from '@langchain/anthropic'
import type { ChainValues } from '@langchain/core/utils/types'
import { PullRequestFile } from './pullRequestService'
import parseDiff from 'parse-diff'
import { LanguageDetectionService } from './languageDetectionService'
import { Effect, Context, Option } from 'effect'
import { NoSuchElementException, UnknownException } from 'effect/Cause'

export interface CodeReviewService {
  codeReviewFor(file: PullRequestFile): Effect.Effect<ChainValues, NoSuchElementException | UnknownException, never>
  codeReviewForChunks(
    file: PullRequestFile
  ): Effect.Effect<ChainValues[], NoSuchElementException | UnknownException, never>
}

export const CodeReviewService = Context.GenericTag<CodeReviewService>('CodeReviewService')

export class CodeReviewServiceImpl implements CodeReviewService {
  private readonly llm: ChatAnthropic
  private readonly chain: LLMChain<string>

  private static readonly SYSTEM_PROMPT = 
    "You are a highly skilled and empathetic software engineer, proficient in all programming languages, frameworks, and software architectures. Your primary goal is to provide constructive feedback and insights."

  private static readonly HUMAN_PROMPT = `You are tasked with reviewing a Pull Request. A git diff will be provided to you. 
      Your responsibilities are to:
      - Evaluate the code for improvements in quality, maintainability, readability, performance, and security.
      - Identify and point out any potential bugs or security risks.
      - Ensure the code adheres to established coding standards and best practices.
      - Recommend adding comments only when they would provide meaningful value or clarification.

      Provide your feedback in GitHub Markdown format. Use concise and actionable language. Assume the programming language for this review is {lang}.

      Git diff to review:

      {diff}`

  constructor(
    private readonly anthropicApiKey: string,
    private readonly modelName: string,
    private readonly temperature: number
  ) {
    this.llm = new ChatAnthropic({
      temperature,
      anthropicApiKey,
      modelName
    }) as any // Temporary workaround for type compatibility

    const prompt = ChatPromptTemplate.fromMessages([
      ['system', CodeReviewServiceImpl.SYSTEM_PROMPT],
      ['human', CodeReviewServiceImpl.HUMAN_PROMPT]
    ])
    
    this.chain = new LLMChain({
      llm: this.llm as any, // Temporary workaround for type compatibility
      prompt: prompt as any // Temporary workaround for type compatibility
    })
  }

  private getLanguage(file: PullRequestFile) {
    return Effect.flatMap(LanguageDetectionService, service =>
      Effect.flatMap(
        Effect.succeed(service.detectLanguage(file.filename)),
        Option.match({
          onNone: () => Effect.fail(new NoSuchElementException()),
          onSome: (lang: string) => Effect.succeed(lang)
        })
      )
    ).pipe(
      Effect.mapError(() => new NoSuchElementException()),
      Effect.provide(LanguageDetectionService.Live)
    )
  }

  private reviewDiff(lang: string, diff: string) {
    return Effect.tryPromise(() => this.chain.call({ lang, diff }))
  }

  codeReviewFor(file: PullRequestFile) {
    if (!file.patch) {
      return Effect.fail(new NoSuchElementException())
    }

    return this.getLanguage(file).pipe(Effect.flatMap(lang => this.reviewDiff(lang, file.patch!)))
  }

  codeReviewForChunks(file: PullRequestFile) {
    if (!file.patch) {
      return Effect.fail(new NoSuchElementException())
    }

    return this.getLanguage(file).pipe(
      Effect.flatMap(lang =>
        Effect.try({
          try: () => parseDiff(file.patch)[0],
          catch: () => new UnknownException({ message: 'Failed to parse diff' })
        }).pipe(
          Effect.flatMap(fileDiff => Effect.all(fileDiff.chunks.map(chunk => this.reviewDiff(lang, chunk.content))))
        )
      )
    )
  }
}
