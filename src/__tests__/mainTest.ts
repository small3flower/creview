import { expect, jest } from '@jest/globals'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { CodeReviewService } from '../services/codeReviewService'
import { PullRequestService } from '../services/pullRequestService'
import { run } from '../main'
import type { PullRequestEvent } from '@octokit/webhooks-definitions/schema'
import { Effect } from 'effect'

class NoSuchElementException extends Error {}
class UnknownException extends Error {}

jest.mock('@actions/core')
jest.mock('@actions/github')
jest.mock('../services/codeReviewService')
jest.mock('../services/pullRequestService')

const mockedCore = jest.mocked(core)
let mockedGitHub: typeof github

beforeEach(() => {
  mockedGitHub = {
    ...jest.mocked(github),
    context: {
      ...github.context,
      eventName: 'pull_request',
      payload: {
        pull_request: {
          head: { sha: 'test-sha' },
          number: 123
        }
      },
      repo: {
        owner: 'test-owner',
        repo: 'test-repo'
      },
      issue: {
        owner: 'test-owner',
        repo: 'test-repo',
        number: 123
      }
    }
  }

  // Override the github module with our mock
  jest.doMock('@actions/github', () => mockedGitHub)
})

afterEach(() => {
  jest.resetModules()
})

// Manual mock implementations
const mockedCodeReviewService = {
  codeReviewFor: jest.fn(() => Effect.succeed({ text: 'test-review' })),
  codeReviewForChunks: jest.fn(() => Effect.succeed([{ text: 'test-chunk-review' }]))
}

const mockedPullRequestService = {
  getFilesForReview: jest.fn(() =>
    Effect.succeed([
      {
        filename: 'test.js',
        patch: 'test-patch',
        sha: 'test-sha',
        status: 'modified',
        additions: 0,
        deletions: 0,
        changes: 0,
        blob_url: '',
        raw_url: '',
        contents_url: ''
      }
    ])
  ),
  createReviewComment: jest.fn(() => Effect.succeed(undefined)),
  createReview: jest.fn(() => Effect.succeed(undefined))
}

// Override the service implementations
jest.mock('../services/codeReviewService', () => ({
  CodeReviewService: jest.fn().mockImplementation(() => mockedCodeReviewService)
}))

jest.mock('../services/pullRequestService', () => ({
  PullRequestService: jest.fn().mockImplementation(() => mockedPullRequestService)
}))

describe('run', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    process.env = {}
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('should fail if github_token is missing', async () => {
    mockedCore.getInput.mockImplementation(input => {
      if (input === 'github_token') return ''
      return 'test'
    })

    await run()
    expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('github_token'))
  })

  it('should fail if anthropic_api_key is missing', async () => {
    mockedCore.getInput.mockImplementation(input => {
      if (input === 'anthropic_api_key') return ''
      return 'test'
    })

    await run()
    expect(mockedCore.setFailed).toHaveBeenCalledWith(expect.stringContaining('anthropic_api_key'))
  })

  it('should use default model name and temperature', async () => {
    mockedCore.getInput.mockImplementation(input => {
      if (input === 'model_name') return ''
      if (input === 'model_temperature') return ''
      return 'test'
    })

    await run()
    expect(mockedCore.getInput).toHaveBeenCalledWith('model_name')
    expect(mockedCore.getInput).toHaveBeenCalledWith('model_temperature')
  })

  it('should fail for non-pull_request events', async () => {
    mockedGitHub.context.eventName = 'push'
    await run()
    expect(mockedCore.setFailed).toHaveBeenCalledWith('This action only works on pull_request events')
  })

  it('should process files for pull_request event', async () => {
    mockedPullRequestService.getFilesForReview.mockImplementation(() =>
      Effect.succeed([
        {
          filename: 'test.js',
          patch: 'test-patch',
          sha: 'test-sha',
          status: 'modified',
          additions: 0,
          deletions: 0,
          changes: 0,
          blob_url: '',
          raw_url: '',
          contents_url: ''
        }
      ])
    )
    mockedCodeReviewService.codeReviewFor.mockImplementation(() => Effect.succeed({ text: 'test-review' }))

    await run()

    expect(mockedPullRequestService.getFilesForReview).toHaveBeenCalledWith(
      'test-owner',
      'test-repo',
      123,
      expect.any(Array)
    )
    expect(mockedCodeReviewService.codeReviewFor).toHaveBeenCalledWith(expect.objectContaining({ filename: 'test.js' }))
    expect(mockedPullRequestService.createReviewComment).toHaveBeenCalledWith(
      expect.objectContaining({
        repo: 'test-repo',
        owner: 'test-owner',
        pull_number: 123
      })
    )
  })

  it('should handle empty exclude_files input', async () => {
    mockedCore.getInput.mockImplementation(input => {
      if (input === 'exclude_files') return ''
      return 'test'
    })

    mockedGitHub.context.eventName = 'pull_request'
    await run()

    expect(mockedCore.getInput).toHaveBeenCalledWith('exclude_files')
  })

  it('should handle service initialization errors', async () => {
    mockedGitHub.context.eventName = 'pull_request'
    jest.spyOn(Effect, 'runPromiseExit').mockImplementation(() => {
      throw new Error('Initialization failed')
    })

    await run()
    expect(mockedCore.setFailed).toHaveBeenCalledWith('Initialization failed')
  })
})
