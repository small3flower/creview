import { Schedule, Effect } from 'effect'

const DEFAULT_RETRIES = 3
const INITIAL_DELAY = 1000
const GROWTH_FACTOR = 2

const createExponentialBackoffWithJitter = (retries: number) =>
  Schedule.recurs(retries).pipe(
    Schedule.compose(Schedule.exponential(INITIAL_DELAY, GROWTH_FACTOR)),
    Schedule.jittered
  )

export const retryWithBackoff = <A, E, R>(effect: Effect.Effect<A, E, R>, retries: number = DEFAULT_RETRIES): Effect.Effect<A, E, R> =>
  Effect.retry(effect, createExponentialBackoffWithJitter(retries))
