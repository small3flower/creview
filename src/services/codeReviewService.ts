import { ChatPromptTemplate, HumanMessagePromptTemplate, SystemMessagePromptTemplate } from 'langchain/prompts'
import { LLMChain } from 'langchain/chains'
import { ChatAnthropic } from 'langchain/chat_models/anthropic'
import type { ChainValues } from 'langchain/dist/schema'
import { PullRequestFile } from './pullRequestService'
import parseDiff from 'parse-diff'
import { LanguageDetectionService } from './languageDetectionService'
import { Effect, Context, Option } from 'effect'
import { NoSuchElementException, UnknownException } from 'effect/Cause'

export interface CodeReviewService {
  codeReviewFor(
    file: PullRequestFile
  ): Effect.Effect<ChainValues, NoSuchElementException | UnknownException, never>
  codeReviewForChunks(
    file: PullRequestFile
  ): Effect.Effect<ChainValues[], NoSuchElementException | UnknownException, never>
}

export const CodeReviewService = Context.GenericTag<CodeReviewService>('CodeReviewService')

export class CodeReviewServiceImpl implements CodeReviewService {
  private readonly llm: ChatAnthropic
  private readonly chain: LLMChain<string>
  
  private static readonly SYSTEM_PROMPT = "Act as an empathetic software engineer that's an expert in all programming languages, frameworks and software architecture."
  private static readonly HUMAN_PROMPT = `Your task is to review a Pull Request. You will receive a git diff. 
    Review it and suggest any improvements in code quality, maintainability, readability, performance, security, etc.
    Identify any potential bugs or security vulnerabilities. Check it adheres to coding standards and best practices.
    Suggest adding comments to the code only when you consider it a significant improvement.
    Write your reply and examples in GitHub Markdown format. The programming language in the git diff is {lang}.

    git diff to review:

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
    })

    this.chain = new LLMChain({
      prompt: ChatPromptTemplate.fromPromptMessages([
        SystemMessagePromptTemplate.fromTemplate(CodeReviewServiceImpl.SYSTEM_PROMPT),
        HumanMessagePromptTemplate.fromTemplate(CodeReviewServiceImpl.HUMAN_PROMPT)
      ]),
      llm: this.llm
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

    return this.getLanguage(file).pipe(
      Effect.flatMap(lang => this.reviewDiff(lang, file.patch!))
    )
  }

  codeReviewForChunks(file: PullRequestFile) {
    if (!file.patch) {
      return Effect.fail(new NoSuchElementException())
    }

    return this.getLanguage(file).pipe(
      Effect.flatMap(lang => 
        Effect.try({
          try: () => parseDiff(file.patch!)[0],
          catch: () => new UnknownException({ message: 'Failed to parse diff' })
        }).pipe(
          Effect.flatMap(fileDiff => 
            Effect.all(fileDiff.chunks.map(chunk => 
              this.reviewDiff(lang, chunk.content)
            ))
          )
        )
      )
    )
  }
}
