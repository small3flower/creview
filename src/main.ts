import { config } from 'dotenv'
import * as core from '@actions/core'
import * as github from '@actions/github'
import type { PullRequestEvent } from '@octokit/webhooks-definitions/schema'

import { CodeReviewService, CodeReviewServiceImpl } from './services/codeReviewService'
import { PullRequestService, PullRequestServiceImpl, octokitTag } from './services/pullRequestService'
import { LanguageDetectionService } from './services/languageDetectionService'

import { Effect, Layer, Match, pipe, Exit } from 'effect'

config()

// Extract configuration logic into a separate function
const getConfig = () => ({
  anthropicApiKey: core.getInput('anthropic_api_key'),
  githubToken: core.getInput('github_token'),
  modelName: core.getInput('model_name'),
  temperature: parseInt(core.getInput('model_temperature'))
})

// Extract file processing logic into a separate function
const processFiles = (owner: string, repo: string, context: typeof github.context) => {
  return pipe(
    Effect.sync(() => github.context.payload as PullRequestEvent),
    Effect.tap(pullRequestPayload =>
      Effect.sync(() => {
        core.info(
          `repoName: ${repo} pull_number: ${context.payload.number} owner: ${owner} sha: ${pullRequestPayload.pull_request.head.sha}`
        )
      })
    ),
    Effect.map(() =>
      core
        .getInput('exclude_files')
        .split(',')
        .map(_ => _.trim())
    ),
    Effect.flatMap(filePattens =>
      PullRequestService.pipe(
        Effect.flatMap(pullRequestService =>
          pullRequestService.getFilesForReview(owner, repo, context.payload.number, filePattens)
        ),
        Effect.flatMap(files => Effect.sync(() => files.filter(file => file.patch !== undefined))),
        Effect.flatMap(files =>
          Effect.forEach(files, file =>
            CodeReviewService.pipe(
              Effect.flatMap(codeReviewService => codeReviewService.codeReviewFor(file)),
              Effect.flatMap(res =>
                PullRequestService.pipe(
                  Effect.flatMap(pullRequestService =>
                    pullRequestService.createReviewComment({
                      repo,
                      owner,
                      pull_number: context.payload.number,
                      commit_id: context.payload.pull_request?.head.sha,
                      path: file.filename,
                      body: res.text,
                      subject_type: 'file'
                    })
                  )
                )
              )
            )
          )
        )
      )
    )
  )
}

export const getRepoContext = () => {
  const context = github.context
  if (!context.repo) {
    throw new Error('GitHub context is missing repo information')
  }
  return {
    owner: context.repo.owner,
    repo: context.repo.repo,
    context
  }
}

export const run = async (): Promise<void> => {
  const llmConfig = getConfig()
  const { owner, repo, context } = getRepoContext()

  const MainLive = initializeServices(
    llmConfig.anthropicApiKey,
    llmConfig.modelName,
    llmConfig.temperature,
    llmConfig.githubToken
  )

  const program = Match.value(context.eventName).pipe(
    Match.when('pull_request', () => processFiles(owner, repo, context)),
    Match.orElse(eventName =>
      Effect.sync(() => {
        core.setFailed(`This action only works on pull_request events. Got: ${eventName}`)
      })
    )
  )

  const runnable = Effect.provide(
    program,
    Layer.provideMerge(
      MainLive,
      Layer.merge(LanguageDetectionService.Live, Layer.succeed(octokitTag, github.getOctokit(llmConfig.githubToken)))
    )
  )
  const result = await Effect.runPromiseExit(runnable as Effect.Effect<void | void[], unknown, never>)

  if (Exit.isFailure(result)) {
    core.setFailed(result.cause.toString())
  }
}

// Simplified service initialization with better type annotations
const initializeServices = (
  anthropicApiKey: string,
  modelName: string,
  temperature: number,
  githubToken: string
): Layer.Layer<never, never, CodeReviewService | PullRequestService> => {
  // Create octokit layer
  const octokitLive = Layer.succeed(octokitTag, github.getOctokit(githubToken))

  // Create CodeReviewService layer
  const CodeReviewServiceLive = Layer.effect(
    CodeReviewService,
    Effect.gen(function* (_) {
      yield* _(LanguageDetectionService)
      return CodeReviewService.of(new CodeReviewServiceImpl(anthropicApiKey, modelName, temperature))
    })
  )

  // Create PullRequestService layer
  const PullRequestServiceLive = Layer.effect(
    PullRequestService,
    Effect.gen(function* (_) {
      const octokit = yield* _(octokitTag)
      return PullRequestService.of(new PullRequestServiceImpl(octokit))
    })
  )

  // Combine layers
  return Layer.provideMerge(
    Layer.merge(CodeReviewServiceLive, PullRequestServiceLive),
    Layer.merge(LanguageDetectionService.Live, octokitLive)
  )
}

run()
