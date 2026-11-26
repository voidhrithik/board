import { describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { conformance } from '../src/conformance/index.ts'
import type { GrantInput } from '../src/api/routes.ts'
import { bearer, BOARD_URL, caller, deploymentToken, personToken, testBoard, workflowToken } from './harness.ts'
import { fakeQueue } from './queue.ts'

type Fetch = (request: Request) => Promise<Response>

/** A board with a scheduler that lets in v0's production deployments and acme/web's runs everywhere, as their own grants. */
async function ownPrincipals() {
  const team = testBoard({ scheduler: fakeQueue().scheduler })
  await team.createGrant({ principals: [{ kind: 'project', project: 'prj_v0', environments: ['production'] }], can: { '*': 'all' } })
  await team.createGrant({ principals: [{ kind: 'github', repository: 'acme/web' }], can: { '*': 'all' } })
  return team
}

/** A board with a scheduler that grants v0's deployments in `environment` what `can` says, before any test request. */
async function grantingV0(environment = 'production', can: GrantInput['can'] = { '*': 'all' }) {
  const board = testBoard({ scheduler: fakeQueue().scheduler })
  await board.createGrant({ principals: [{ kind: 'project', project: 'prj_v0', environments: [environment] }], can })
  return board
}

/** A handle on the board behind `fetch`, as `vb conformance` checks it. */
const clientOf = async (fetch: Fetch) => clientAs(fetch, () => personToken())

/** A handle on the board behind `fetch`, with the token `token` gives. */
const clientAs = async (fetch: Fetch, token: () => Promise<string>) =>
  board({ backend: http(BOARD_URL, { fetch: bearer((input, init) => fetch(new Request(input, init)), token) }) }).as(null)

/** The same handle as `token` gives, narrowed with `x-board-can`, as `vb conformance` opens one. */
const withCan =
  (fetch: Fetch, token: () => Promise<string> = () => personToken()) =>
  (can: string) =>
    board({
      backend: http(BOARD_URL, {
        fetch: bearer((input, init) => {
          const request = new Request(input, init)
          request.headers.set('x-board-can', can)
          return fetch(request)
        }, token),
      }),
    }).as(null)

/** The same handle as `token` gives, with `headers` on every request, as `vb conformance` opens one. */
const withHeaders =
  (fetch: Fetch, token: () => Promise<string> = () => personToken()) =>
  (headers: Record<string, string>) =>
    board({
      backend: http(BOARD_URL, {
        fetch: bearer((input, init) => {
          const request = new Request(input, init)
          for (const [name, value] of Object.entries(headers)) request.headers.set(name, value)
          return fetch(request)
        }, token),
      }),
    }).as(null)

/** The checks of who writes that send headers of their own, which a run that can't send them skips. */
const HEADERS = [
  'takes a profile and its avatar as one x-board-profile header, and shows both on what it writes',
  'lets a profile change only its own messages, and its principal all of them',
  "ignores x-board-avatar, which x-board-profile's avatar parameter replaced",
  'ignores x-board-session: who writes is the principal and its profile',
]
const NO_HEADERS = "this run can't call the board with headers of its own"

/** The checks of a caller narrowed with x-board-can, which a run that can't send the header skips. */
const NARROWED = [
  'narrows a caller to what its x-board-can says',
  'takes label in its channel to claim a task: a caller narrowed to reading and posting claims none',
  "takes read in a prerequisite's channel to wait for it: a caller narrowed out of it makes no task that needs it",
  'refuses a caller narrowed with x-board-can a schema, and lets it read them',
  "refuses a caller narrowed with x-board-can its principal's watchers: registering, pulling, and acking",
  "refuses a caller narrowed with x-board-can sync's records: imports, receipts, and the inbox",
]
const NO_CAN = "this run can't call the board with an x-board-can header"

/** The grants checks a board without team roles skips, and why: a run names no viewer, and grants don't cross teams yet. */
const NO_ROLES = ['caps a person by their team role, so a viewer reads but neither posts nor manages', 'name a viewer in principals to check it: a board without team roles caps no one']
const NO_APPS = ['names an app by its slug or client ID, keeps it by client ID, and every app as a group', 'name an app in principals to check it: a local board has no apps']
const CROSS_TEAM = ['lets a project on another team in, in its environments', "grants across teams aren't specified yet: what a project on another team needs, and what all-projects means for one, comes later"]
/** The tasks check a board's own code skips: its profiles are `board:client:<profile>`, principals of their own. */
/** The tasks check that sends headers of its own: a profile, narrowed to no `manage`. */
const TASKS_OWNED = 'lets a profile change only the tasks it made, and its principal all of them'
const OWN_PROFILES = ['keeps a task assigned to a profile for that actor alone', "this handle's profiles are principals of their own, so none is its principal's actor"]
/** And one no run can check: shut out by a lock, it couldn't lift the lock after. */
/** The check a run nothing locks out skips: the board's own code here, and a board's owner. */
const NEVER_LOCKED_OUT = ["refuses a grant its maker couldn't take back, unless it says lockMeOut", "nothing locks this run out of a channel, so no grant it makes is a lockout: it owns the board, or it's the board's own code"]
const LOCKED_OUT = ['lets a member grant on a pattern after a lock under it', "a run can't be shut out by a lock and lift it afterwards: the board's own tests check it"]
const skipped = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.filter((check) => check.status !== 'passed').map((check) => [check.name, check.detail])

/** The grants checks of a caller narrowed with x-board-can, which a run that can't send the header skips too. */
const GRANTS_NARROWED = [
  'takes manage at each pattern a grant names to change it, and at * to list them',
  "lets no caller narrowed with x-board-can grant past its can, even where everyone's grant closes it",
  'lets no caller narrowed with x-board-can let anyone in where everyone gets more than it has',
]

/** A board in front of `fetch` that rewrites what it answers, or what it's asked. */
function broken(fetch: Fetch, change: { request?: (url: URL) => void; body?: (text: string) => string }): Fetch {
  return async (request) => {
    const url = new URL(request.url)
    change.request?.(url)
    const response = await fetch(new Request(url, request))
    if (!change.body || !response.headers.get('content-type')?.includes('application/json')) return response
    return new Response(change.body(await response.text()), { status: response.status, headers: response.headers })
  }
}

/** A board in front of `fetch` from before `path`: a registration drops it, as its schema did. */
function withoutPath(fetch: Fetch): Fetch {
  return async (request) => {
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/watchers')) return fetch(request)
    const { path: _path, ...body } = await request.json()
    return fetch(new Request(request, { body: JSON.stringify(body) }))
  }
}

/**
 * A board in front of `fetch` that wakes by path, as the team board does: it refuses a path from a
 * person, and keeps each owner's path (and a preview's branch) itself, beside the registration the
 * board under it holds, which wakes nothing.
 */
function wakingByPath(fetch: Fetch): Fetch {
  const paths = new Map<string, { path: string; branch?: string }>()
  const shown = (found: { owner: string }) => ({ ...found, ...paths.get(found.owner) })
  return async (request) => {
    const url = new URL(request.url)
    if (request.method === 'POST' && url.pathname.endsWith('/watchers')) {
      const { path, branch, ...body } = await request.json()
      const claims = JSON.parse(Buffer.from(request.headers.get('authorization')!.split('.')[1]!, 'base64url').toString())
      if (path && claims.user_id) return Response.json({ error: { code: 'not_a_project', message: "a path is on the caller's own project" } }, { status: 403 })
      const response = await fetch(new Request(request, { body: JSON.stringify(body) }))
      if (!response.ok) return response
      const made = await response.json()
      if (path) paths.set(made.owner, { path, ...(branch ? { branch } : {}) })
      else paths.delete(made.owner)
      return Response.json(shown(made))
    }
    const response = await fetch(request)
    if (!response.headers.get('content-type')?.includes('application/json')) return response
    if (request.method === 'GET' && url.pathname.endsWith('/watchers')) {
      const { watchers } = await response.json()
      return Response.json({ watchers: watchers.map(shown) }, { status: response.status })
    }
    if (request.method === 'GET' && url.pathname.replace(/\/$/, '') === new URL(BOARD_URL).pathname)
      return Response.json({ wake_by_path: true, ...(await response.json()) }, { status: response.status })
    return response
  }
}

/** The watcher and sync checks' statuses, in order. */
const watcherStatuses = (report: Awaited<ReturnType<typeof conformance>>) =>
  report.checks.filter((check) => check.group === 'watchers' || check.group === 'sync').map((check) => check.status)

// Each of these runs the kit against a board, some more than once: seconds each, and more under a full run.
vi.setConfig({ testTimeout: 30_000 })

describe('the conformance kit', () => {
  it('passes a board on a2(), checking the whole protocol, and deletes what it posted', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const client = await clientOf(board.fetch)
    const report = await conformance(client, { withHeaders: withHeaders(board.fetch) })
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([])
    // withHeaders stands in for withCan, so the narrowing checks run too.
    expect(report.checks.filter((check) => [...NARROWED, ...GRANTS_NARROWED].includes(check.name)).map((check) => check.status)).toEqual([...NARROWED, ...GRANTS_NARROWED].map(() => 'passed'))
    expect(report.checks.filter((check) => [...HEADERS, 'shows no session on a message, its event, or you'].includes(check.name)).map((check) => check.status)).toEqual(Array(5).fill('passed'))
    expect(skipped(report)).toEqual([NO_ROLES, NO_APPS, LOCKED_OUT, CROSS_TEAM])
    expect(report).toMatchObject({ ok: true, url: BOARD_URL })
    // Every grant it made is gone, the ones that closed a pattern to everyone included.
    expect((await client.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
    expect([...new Set(report.checks.map((check) => check.group))]).toEqual(['core', 'paging', 'search', 'schedules', 'tasks', 'grants', 'schemas', 'attachments', 'watchers', 'sync'])
    expect(report.checks.filter((check) => check.group === 'tasks').map((check) => check.status)).toEqual(Array.from({ length: 25 }, () => 'passed'))
    const { messages } = await client.channel('conformance').messages({ limit: 500 })
    expect(messages.filter((message) => !message.deleted)).toEqual([])
    // Every task it made went with its root: none is left open, and none still wears a state.
    expect((await client.tasks.list({ channel: 'conformance', state: 'all' })).tasks).toEqual([])
    expect((await client.threads({ channel: 'conformance', label: ['board.task'], limit: 500 })).threads).toEqual([])
  })

  it("passes through a board's own handle, in-process", async () => {
    const team = testBoard({ scheduler: fakeQueue().scheduler })
    const report = await conformance(team)
    // The board's own code needs no grant to keep it in what it closes, and no proxy narrows it. Each
    // of its profiles is a principal of its own there, so none is an actor a task of its own could be for.
    expect(skipped(report)).toEqual([
      [NARROWED[0], NO_CAN],
      ...HEADERS.map((name) => [name, NO_HEADERS]),
      OWN_PROFILES,
      [TASKS_OWNED, NO_HEADERS],
      [NARROWED[1], NO_CAN],
      [NARROWED[2], NO_CAN],
      NO_ROLES,
      NO_APPS,
      ...GRANTS_NARROWED.map((name) => [name, NO_CAN]),
      NEVER_LOCKED_OUT,
      LOCKED_OUT,
      CROSS_TEAM,
      [NARROWED[3], NO_CAN],
      [NARROWED[4], NO_CAN],
      [NARROWED[5], NO_CAN],
    ])
    expect((await team.me()).actor).toBe('board:client')
  })

  it("fails a board that lets a profile change another profile's messages, or keeps its principal from changing them", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const owns = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name === HEADERS[1])
    // A board that takes an edit or a delete as the principal's, whatever profile sent it.
    const principalOnly: Fetch = (request) => {
      if (request.method !== 'POST' || !/\/messages\/[^/]+\/(edit|delete)$/.test(new URL(request.url).pathname)) return board.fetch(request)
      const headers = new Headers(request.headers)
      headers.delete('x-board-profile')
      return board.fetch(new Request(request, { headers }))
    }
    expect(owns(await conformance(await clientOf(board.fetch), { withHeaders: withHeaders(principalOnly) }))).toMatchObject({
      status: 'failed',
      detail: "an edit, by a profile, of another profile's message: expected 403, and it succeeded",
    })
    // And one that holds the principal itself to what it wrote as no profile.
    const strict: Fetch = async (request) => {
      const path = new URL(request.url).pathname
      if (request.method !== 'POST' || !/\/messages\/[^/]+\/(edit|delete)$/.test(path) || request.headers.has('x-board-profile')) return board.fetch(request)
      const read = await board.fetch(new Request(`${BOARD_URL}/messages/${path.split('/').at(-2)}`, { headers: request.headers }))
      if ((await read.json()).message.by.profile === null) return board.fetch(request)
      return Response.json({ error: { code: 'forbidden', message: 'only the author can edit a message' } }, { status: 403 })
    }
    expect(owns(await conformance(await clientOf(strict), { withHeaders: withHeaders(board.fetch) }))).toMatchObject({ status: 'failed', detail: expect.stringContaining('only the author can edit a message') })
  })

  it('fails a board that takes a change of what a task needs and changes nothing', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    // It answers the task as it is, whatever it was asked to wait for.
    const deaf: Fetch = async (request) => {
      const { pathname } = new URL(request.url)
      const changing = request.method === 'POST' ? /\/tasks\/([^/]+)\/needs$/.exec(pathname) : null
      if (!changing) return board.fetch(request)
      const read = await board.fetch(new Request(`${BOARD_URL}/messages/${changing[1]}`, { headers: request.headers }))
      return Response.json({ task: (await read.json()).message })
    }
    const report = await conformance(await clientOf(deaf))
    const failed = report.checks.filter((check) => check.group === 'tasks' && check.status === 'failed').map((check) => [check.name, check.detail])
    expect(failed).toEqual([
      ['changes what a task needs: it waits for the new ones, is ready once they have completed, and at once with none', 'a ready task, once it needs one that has not completed: expected "waiting", got "ready"'],
      ['refuses a change of needs that would make a task wait for itself, straight back or through others', 'a task that would need itself: expected 400 invalid_needs, and it succeeded'],
      ['changes what a task needs only while no one holds it and it has not finished', 'changing what a claimed task needs: expected 409 task_claimed, and it succeeded'],
    ])
  }, 60_000)

  it("fails a board that answers a create under a reply's ID with the task its thread is", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    // It finds the post the ID landed with, and answers its thread's task whatever that post is.
    let made: string | null = null
    const threadFirst: Fetch = async (request) => {
      const creating = request.method === 'POST' && new URL(request.url).pathname.endsWith('/tasks')
      const response = await board.fetch(request)
      if (!creating) return response
      if (response.status === 201) made = await response.clone().text()
      return response.status === 409 && made !== null ? new Response(made, { status: 201, headers: { 'content-type': 'application/json' } }) : response
    }
    const report = await conformance(await clientOf(threadFirst))
    expect(report.checks.find((check) => check.name === 'makes a task once for a client ID, and none under an ID a reply or a plain thread landed with')).toMatchObject({
      status: 'failed',
      detail: 'a task under an ID a reply landed with: expected 409 duplicate_id, and it succeeded',
    })
  }, 60_000)

  it("fails a board that lists what waits for a task from every channel, or lets a caller wait for one it can't read", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const find = (report: Awaited<ReturnType<typeof conformance>>, name: string) => report.checks.find((check) => check.name === name)
    // One whose list of what waits for a task looks past the channel it was asked for, to every one its caller reads.
    const everywhere = broken(board.fetch, {
      request: (url) => {
        if (url.pathname.endsWith('/tasks') && url.searchParams.has('needs') && !url.searchParams.get('channel')?.endsWith('/')) url.searchParams.delete('channel')
      },
    })
    expect(find(await conformance(await clientOf(everywhere)), 'lists the tasks that wait for one in the channel a list names, or its subtree, and no other')).toMatchObject({
      status: 'failed',
      detail: expect.stringMatching(/^the tasks that wait for one, in conformance: expected \["(\d+)"\], got \["\1","\d+"\]$/),
    })
    // And one that checks a prerequisite against what its caller's credential reads, not what the caller was narrowed to.
    const unheld: Fetch = async (request) => {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/tasks') || !('needs' in ((await request.clone().json()) as object))) return board.fetch(request)
      const headers = new Headers(request.headers)
      headers.delete('x-board-can')
      return board.fetch(new Request(request, { headers }))
    }
    expect(find(await conformance(await clientOf(board.fetch), { withCan: withCan(unheld) }), "takes read in a prerequisite's channel to wait for it: a caller narrowed out of it makes no task that needs it")).toMatchObject({
      status: 'failed',
      detail: "a task that needs one its caller can't read: expected 400 invalid_needs, and it succeeded",
    })
    // What the kit made there went with the run.
    expect((await board.tasks.list({ channel: 'conformance/', state: 'open' })).tasks).toEqual([])
  }, 60_000)

  it("fails a board that lets a profile change its principal's tasks or another profile's, or holds no task when a profile edits its thread", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const owned = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name === TASKS_OWNED)
    /** A board that takes the requests `match` picks as the principal's, whatever profile sent them. */
    const principalOnly = (match: (method: string, path: string) => boolean): Fetch => (request) => {
      if (!match(request.method, new URL(request.url).pathname)) return board.fetch(request)
      const headers = new Headers(request.headers)
      headers.delete('x-board-profile')
      return board.fetch(new Request(request, { headers }))
    }
    // One that goes by the principal alone for a task's owner-side changes: a profile gives itself its principal's task.
    const changes = principalOnly((method, path) => method === 'POST' && /\/tasks\/[^/]+\/(assign|block|unblock|reopen|cancel)$/.test(path))
    expect(owned(await conformance(await clientOf(board.fetch), { withHeaders: withHeaders(changes) }))).toMatchObject({
      status: 'failed',
      detail: "assigning its principal's task to itself, by a profile: expected 403 task_not_owned, and it succeeded",
    })
    // And one that takes a profile's edit of its thread as its principal's, the task's owner: nothing holds the task.
    const edits = principalOnly((method, path) => method === 'POST' && /\/messages\/[^/]+\/edit$/.test(path))
    expect(owned(await conformance(await clientOf(board.fetch), { withHeaders: withHeaders(edits) }))).toMatchObject({
      status: 'failed',
      detail: `its principal's task, once the profile that wrote its root edited it: expected "blocked", got "ready"`,
    })
  }, 60_000)

  it('fails a board that says it made a schema version that was there, or takes another definition for one', async () => {
    const registers = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name.startsWith('registers a schema version once'))
    const plain = testBoard({ scheduler: fakeQueue().scheduler })
    expect(registers(await conformance(await clientOf(plain.fetch)))).toMatchObject({ status: 'passed' })

    const always = broken(plain.fetch, { body: (text) => text.replace('"created":false', '"created":true') })
    expect(registers(await conformance(await clientOf(always)))).toMatchObject({ status: 'failed', detail: 'whether registering the same definition again made one: expected false, got true' })

    // A board that answers the version it has when it's sent another definition, as if it were the same.
    const lenient: Fetch = async (request) => {
      const response = await plain.fetch(request.clone())
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/schemas') || response.status !== 409) return response
      const { name, version } = await request.json()
      const kept = await plain.fetch(new Request(`${BOARD_URL}/schemas/${name}@${version}`, { headers: request.headers }))
      return Response.json({ ...(await kept.json()), created: false })
    }
    expect(registers(await conformance(await clientOf(lenient)))).toMatchObject({ status: 'failed', detail: 'another definition for a version that is there: expected 409 schema_immutable, and it succeeded' })
  })

  it("fails a board that lets its caller lock itself out without a word, and one that takes no lockMeOut before it makes a lock", async () => {
    const lockout = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name === NEVER_LOCKED_OUT[0])
    const grantWrite = (request: Request) => request.method === 'POST' && /\/grants(\/batch)?$/.test(new URL(request.url).pathname)
    const again = (request: Request, body: unknown) => new Request(request.url, { method: 'POST', headers: request.headers, body: JSON.stringify(body) })
    const plain = testBoard({ scheduler: fakeQueue().scheduler })
    expect(lockout(await conformance(await clientOf(plain.fetch)))).toMatchObject({ status: 'passed' })

    // A board that judges no lockout: every grant write goes ahead, as if it had said to.
    const loose = testBoard({ scheduler: fakeQueue().scheduler })
    const careless: Fetch = async (request) => (grantWrite(request) ? loose.fetch(again(request, { ...(await request.json()), lockMeOut: true })) : loose.fetch(request))
    expect(lockout(await conformance(await clientOf(careless)))).toMatchObject({ status: 'failed', detail: expect.stringContaining('expected 409 grant_lockout, and the board made') })

    // A board from before lockMeOut refuses the key, as an unknown one, and judges no lockout either.
    // The check stops at the refusal, so it makes no lock there that the run couldn't revoke.
    const old = testBoard({ scheduler: fakeQueue().scheduler })
    const strict: Fetch = async (request) => {
      if (!grantWrite(request)) return old.fetch(request)
      const body = await request.json()
      if ('lockMeOut' in body) return Response.json({ error: { code: 'invalid_request', message: 'unknown key: lockMeOut' } }, { status: 400 })
      return old.fetch(again(request, { ...body, lockMeOut: true }))
    }
    expect(lockout(await conformance(await clientOf(strict)))).toMatchObject({ status: 'failed', detail: 'a grant that says lockMeOut: expected it made, got 400 invalid_request' })
    expect((await old.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
  }, 60_000)

  it('fails a board that makes part of a batch of grants it refuses, and revokes what it made of it', async () => {
    const BATCH_OF_GRANTS = 'makes several grants in one write, or none of them, a lock with the grant that keeps its maker in'
    const batch = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name === BATCH_OF_GRANTS)
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    expect(batch(await conformance(await clientOf(board.fetch)))).toMatchObject({ status: 'passed' })
    // A board that makes a batch's grants one by one, up to the one it refuses.
    const piecemeal: Fetch = async (request) => {
      const response = await board.fetch(request.clone())
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/grants/batch') || response.status !== 400) return response
      const { grants } = await request.json()
      await board.fetch(new Request(request.url.replace(/\/batch$/, ''), { method: 'POST', headers: request.headers, body: JSON.stringify(grants[0]) }))
      return response
    }
    expect(batch(await conformance(await clientOf(piecemeal)))).toMatchObject({ status: 'failed', detail: expect.stringMatching(/^the grants after a batch that was refused: expected /) })
    expect((await board.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
  }, 60_000)

  it('fails a board that ignores x-board-can, and skips its checks where it can\'t send the header', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    // A board that answers as if no proxy narrowed the caller, as one that doesn't read the header does.
    const ignoring: Fetch = (request) => {
      const headers = new Headers(request.headers)
      headers.delete('x-board-can')
      return board.fetch(new Request(request, { headers }))
    }
    const report = await conformance(await clientOf(board.fetch), { withCan: withCan(ignoring) })
    expect(report.checks.filter((check) => NARROWED.includes(check.name)).map((check) => [check.status, check.detail])).toEqual([
      ['failed', 'what a caller narrowed to read says it may do: expected {"conformance":["read"]}, got {"*":["read","post","react","label","sync","manage"]}'],
      ['failed', 'a claim by a caller without label in its channel: expected 403 forbidden, and it succeeded'],
      ['failed', "a task that needs one its caller can't read: expected 400 invalid_needs, and it succeeded"],
      ['failed', 'registering a schema, by a caller narrowed with x-board-can: expected 403 forbidden, and it succeeded'],
      ['failed', 'registering watchers, by a caller narrowed with x-board-can: expected 403 forbidden, and it succeeded'],
      ['failed', 'an import, by a caller narrowed with x-board-can: expected 403 forbidden, and it succeeded'],
    ])
    // What a board wrongly took, the kit put back: no watchers, and nothing it imported left in the channel.
    expect((await board.watchers()).filter((registration) => Object.keys(registration.watch).length > 0 || (registration.sync?.length ?? 0) > 0)).toEqual([])
    expect((await board.channel('conformance').messages({ limit: 500 })).messages.filter((message) => !message.deleted)).toEqual([])
    const without = await conformance(await clientOf(board.fetch))
    expect(without.checks.filter((check) => NARROWED.includes(check.name)).map((check) => [check.status, check.detail])).toEqual(NARROWED.map(() => ['skipped', NO_CAN]))
  })

  it("leaves a token's registration as it was: one with watchers or a sync is skipped, and an empty one is checked", async () => {
    const board = await grantingV0()
    const v0 = caller(board.fetch, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production'))
    const narrowedV0 = { withCan: withCan(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production')) }
    const registered = async () => (await v0('GET', '/watchers')).body.watchers.map(({ hash: _hash, ...rest }: { hash: string }) => rest)
    for (const registration of [
      // A sync elsewhere with no watchers of its own, and watchers with no sync.
      { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] },
      { watch: { fix: { tail: 'feedback' } }, sync: [] },
    ]) {
      expect((await v0('POST', '/watchers', registration)).status).toBe(200)
      const before = await registered()
      const report = await conformance(asV0, narrowedV0)
      // What registers is skipped; noSync, an account lookup, and a narrowed caller's refused registration register nothing.
      expect(watcherStatuses(report)).toEqual(['skipped', 'skipped', 'passed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'passed', 'skipped'])
      expect(await registered()).toEqual(before)
    }
    // One with nothing in it is checked, and is left as it was.
    const empty = { owner: 'vercel:project:prj_v0:production', url: null, watch: {}, sync: [] }
    expect((await v0('POST', '/watchers', { watch: {} })).status).toBe(200)
    const report = await conformance(asV0, narrowedV0)
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
    expect(await registered()).toEqual([empty])
  })

  it('replaces nothing on a board from before `path`, which reads one as a registration with nothing in it', async () => {
    const older = withoutPath((await grantingV0()).fetch)
    const v0 = caller(older, await deploymentToken('v0', 'prj_v0', 'production'))
    const asV0 = await clientAs(older, () => deploymentToken('v0', 'prj_v0', 'production'))
    const narrowedV0 = { withCan: withCan(older, () => deploymentToken('v0', 'prj_v0', 'production')) }
    const watching = { url: null, watch: { fix: { tail: 'feedback' } }, sync: [] }
    expect((await v0('POST', '/watchers', watching)).status).toBe(200)
    expect(watcherStatuses(await conformance(asV0, narrowedV0))).toEqual(['skipped', 'skipped', 'passed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'passed', 'skipped'])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([watching])
    // An empty one fails the check, since the board took the path, and is left as it was.
    expect((await v0('POST', '/watchers', { watch: {} })).status).toBe(200)
    const report = await conformance(asV0, narrowedV0)
    expect(report.checks.filter((check) => check.status === 'failed')).toMatchObject([
      { name: 'wakes by path only where its discovery says so, and only a Vercel project', detail: 'a path, on a board that wakes nothing: expected 501 no_wake_by_path, and it succeeded' },
    ])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, watch: {} }])
  })

  it("passes a board that wakes by path, which a project registers on and gets back, and refuses anyone else's", async () => {
    const byPath = wakingByPath((await grantingV0()).fetch)
    const v0 = caller(byPath, await deploymentToken('v0', 'prj_v0', 'production'))
    expect((await v0('POST', '/watchers', { path: '/api/board', watch: {} })).status).toBe(200)
    const report = await conformance(await clientAs(byPath, () => deploymentToken('v0', 'prj_v0', 'production')), { withCan: withCan(byPath, () => deploymentToken('v0', 'prj_v0', 'production')) })
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
    expect((await v0('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, path: '/api/board', watch: {} }])
    // A person's token names no project to wake.
    const personal = wakingByPath(testBoard({ scheduler: fakeQueue().scheduler }).fetch)
    const person = await conformance(await clientOf(personal), { withCan: withCan(personal) })
    expect(watcherStatuses(person)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
  })

  it("checks a preview's path with its branch, and gives the branch back", async () => {
    const byPath = wakingByPath((await grantingV0('preview')).fetch)
    const preview = caller(byPath, await deploymentToken('v0', 'prj_v0', 'preview'))
    expect((await preview('POST', '/watchers', { path: '/api/board', branch: 'jb/watchers', watch: {} })).status).toBe(200)
    const report = await conformance(await clientAs(byPath, () => deploymentToken('v0', 'prj_v0', 'preview')), { withCan: withCan(byPath, () => deploymentToken('v0', 'prj_v0', 'preview')) })
    expect(watcherStatuses(report)).toEqual(['passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed', 'passed'])
    expect((await preview('GET', '/watchers')).body.watchers).toMatchObject([{ url: null, path: '/api/board', branch: 'jb/watchers', watch: {} }])
  })

  it('skips paging back on a board from before `older`, and fails one that lists a thread twice', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const paging = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.filter((check) => check.group === 'paging').map((check) => [check.status, check.detail])
    const unpaged: Fetch = async (request) => {
      const response = await board.fetch(request)
      if (!new URL(request.url).pathname.endsWith('/threads') || !response.ok) return response
      const { older: _, ...page } = await response.json()
      return Response.json(page)
    }
    expect(paging(await conformance(await clientOf(unpaged)))).toEqual([
      ['skipped', "this board doesn't page threads back: its pages have no older"],
      ['skipped', "this board doesn't page threads back: its pages have no older"],
    ])
    // A board whose `older` starts over: the second page is the first again.
    const restarted: Fetch = async (request) => {
      const url = new URL(request.url)
      if (!url.pathname.endsWith('/threads')) return board.fetch(request)
      const again = url.searchParams.get('before') === 'again'
      url.searchParams.delete('before')
      const page = await (await board.fetch(new Request(url, request))).json()
      return Response.json({ ...page, older: again ? null : page.older && 'again' })
    }
    expect(paging(await conformance(await clientOf(restarted)))[0]).toEqual(['failed', expect.stringMatching(/^paging back should list each thread once, got \[/)])
  })

  it("fails a board that reads who writes as boards did before: a profile's name alone, an avatar from x-board-avatar, and a session on each by", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const older: Fetch = async (request) => {
      const headers = new Headers(request.headers)
      // The name alone, with the avatar x-board-avatar names, and the session it kept.
      const name = headers.get('x-board-profile')?.split(';')[0]!.trim()
      const avatar = headers.get('x-board-avatar')
      if (name) headers.set('x-board-profile', avatar ? `${name};avatar="${avatar}"` : name)
      headers.delete('x-board-avatar')
      const session = headers.get('x-board-session')
      headers.delete('x-board-session')
      const response = await board.fetch(new Request(request, { headers }))
      if (!response.headers.get('content-type')?.includes('application/json')) return response
      return new Response((await response.text()).replaceAll('"profile":', `"session":${JSON.stringify(session)},"profile":`), { status: response.status, headers: response.headers })
    }
    const report = await conformance(await clientOf(older), { withHeaders: withHeaders(older) })
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.name, check.detail])).toEqual([
      [HEADERS[0], `the profile's avatar, from its header's parameter: expected "https://example.com/conformance.png", got null`],
      [HEADERS[2], `the avatar of a profile whose header names none, whatever x-board-avatar says: expected null, got "https://example.com/conformance.png"`],
      [HEADERS[3], expect.stringMatching(/^a post with x-board-session should carry no session, got \{.*"session":/)],
      ['shows no session on a message, its event, or you', expect.stringMatching(/^a message should carry no session, got \{.*"session":/)],
    ])
    const { messages } = await board.channel('conformance').messages({ limit: 500 })
    expect(messages.filter((message) => !message.deleted)).toEqual([])
  })

  it('reports schedules and files as not kept here on a board without a scheduler or a blob store', async () => {
    // A board on a2() with only its store answers 501 for each, and the kit reads that.
    const bare = testBoard({ blob: undefined })
    const report = await conformance(await clientOf(bare.fetch), { withHeaders: withHeaders(bare.fetch) })
    expect(report.ok).toBe(true)
    expect(report.checks.filter((check) => check.status !== 'passed').map((check) => [check.group, check.status, check.detail])).toEqual([
      ['schedules', 'skipped', "not kept here: this board has no scheduler, so it can't send later"],
      ['schedules', 'skipped', "not kept here: this board has no scheduler, so it can't send later"],
      ['grants', 'skipped', NO_ROLES[1]],
      ['grants', 'skipped', NO_APPS[1]],
      ['grants', 'skipped', LOCKED_OUT[1]],
      ['grants', 'skipped', CROSS_TEAM[1]],
      ['attachments', 'skipped', 'not kept here: this board keeps no files'],
      ['attachments', 'skipped', 'not kept here: this board keeps no files'],
      ['attachments', 'skipped', 'not kept here: this board keeps no files'],
    ])
  })

  it('reports tasks as not kept here on a board that answers 501 no_tasks, and writes none of what the group would', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const asked: string[] = []
    // A board that keeps no tasks, as a backend of one's own may answer: every task route says so.
    const taskless: Fetch = async (request) => {
      const { pathname } = new URL(request.url)
      if (!/\/tasks(\/|$)/.test(pathname)) return board.fetch(request)
      asked.push(`${request.method} ${pathname.slice(pathname.indexOf('/tasks'))}`)
      return Response.json({ error: { code: 'no_tasks', message: 'this board keeps no tasks' } }, { status: 501 })
    }
    const report = await conformance(await clientOf(taskless))
    expect(report.ok).toBe(true)
    const tasks = report.checks.filter((check) => check.group === 'tasks')
    expect(tasks).toHaveLength(25)
    // The one that needs no task route is about labels, which a board has either way.
    expect(tasks.filter((check) => check.status !== 'skipped').map((check) => check.name)).toEqual([])
    expect([...new Set(tasks.map((check) => check.detail))]).toEqual(['not kept here: this board keeps no tasks'])
    // The check that imports from a platform asks about tasks first, so nothing was imported for it.
    expect((await board.channel('conformance').messages({ limit: 500 })).messages.filter((message) => message.text.includes('to make a task'))).toEqual([])
    expect(asked.length).toBeGreaterThan(0)
  })

  it("fails a board that gets tasks wrong: one that drops needs, one that ignores a lease, and one that shows a claim's token", async () => {
    const failed = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.filter((check) => check.group === 'tasks' && check.status === 'failed').map((check) => [check.name, check.detail])
    /** A board in front of `fetch` that changes the JSON body of the requests `match` picks. */
    const rewriting = (fetch: Fetch, match: (method: string, path: string) => boolean, change: (body: Record<string, unknown>) => void): Fetch => async (request) => {
      if (!match(request.method, new URL(request.url).pathname)) return fetch(request)
      const body = (await request.json()) as Record<string, unknown>
      change(body)
      return fetch(new Request(request, { body: JSON.stringify(body) }))
    }
    // A board that hasn't built dependencies: a task that needs another is ready at once.
    const flat = testBoard({ scheduler: fakeQueue().scheduler })
    const noNeeds = rewriting(flat.fetch, (method, path) => method === 'POST' && path.endsWith('/tasks'), (body) => delete body.needs)
    expect(failed(await conformance(await clientOf(noNeeds)))).toEqual([
      ['holds a task until the tasks it needs complete, which a failed or canceled one never does', 'a task that needs one that has not completed: expected "waiting", got "ready"'],
      ['refuses a prerequisite that was canceled, which can never complete, and takes one that failed', 'a task that needs a canceled one: expected 400 invalid_needs, and it succeeded'],
      ['lists the tasks that wait for one in the channel a list names, or its subtree, and no other', expect.stringMatching(/^what the task in the channel needs: expected \["\d+"\], got \[\]$/)],
      // It never waits, so nothing says it became ready: its feed has no task.ready.
      [
        'says task.ready each time a task that needs others becomes ready: right after it is made or unblocked, once they have completed',
        expect.stringContaining('got [["task.created","ready"],["task.claimed","claimed"],["task.blocked","blocked"],["task.unblocked","ready"]]'),
      ],
      // Nothing was made to wait for another, so no change closes a cycle.
      ['refuses a change of needs that would make a task wait for itself, straight back or through others', 'a task that would need one that waits for it: expected 400 invalid_needs, and it succeeded'],
      ['shows a feed that filters on board.task=ready a task becoming ready and being claimed, and never a token', 'the feed should show the task become ready, within a few seconds'],
    ])
    // One that ignores latest: it lists the first made, as without it.
    const first = testBoard({ scheduler: fakeQueue().scheduler })
    const noLatest: Fetch = async (request) => {
      const url = new URL(request.url)
      if (request.method !== 'GET' || !url.pathname.endsWith('/tasks') || !url.searchParams.has('latest')) return first.fetch(request)
      url.searchParams.delete('latest')
      return first.fetch(new Request(url, request))
    }
    expect(failed(await conformance(await clientOf(noLatest)))).toEqual([
      ['lists the last active tasks with latest, wherever they come in the order they were made', 'with latest, the tasks should list the latest active last, within a few seconds'],
    ])
    // One that gives every claim its own default lease, whatever it asked for.
    const fixed = testBoard({ scheduler: fakeQueue().scheduler })
    const noLease = rewriting(fixed.fetch, (method, path) => method === 'POST' && /\/tasks\/[^/]+\/(claim|renew)$/.test(path), (body) => delete body.lease)
    expect(failed(await conformance(await clientOf(noLease)))).toMatchObject([
      ['gives a claim the lease it asks for, up to 5 minutes, and says when it ends', expect.stringMatching(/^a claim that asks for 300 seconds should end in 300, got /)],
    ])
    // One that shows a claim's token to whoever reads the task: its thread carries what the claim answered.
    const leaky = testBoard({ scheduler: fakeQueue().scheduler })
    const tokens = new Map<string, string>()
    const showing: Fetch = async (request) => {
      const { pathname } = new URL(request.url)
      const response = await leaky.fetch(request)
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return response
      const body = await response.json()
      if (request.method === 'POST' && /\/tasks\/[^/]+\/claim$/.test(pathname)) tokens.set(body.task.id, body.claim.token)
      const read = request.method === 'GET' ? /\/messages\/([^/]+)$/.exec(pathname)?.[1] : undefined
      if (read !== undefined && body.message?.task?.claim && tokens.has(read)) body.message.task.claim.token = tokens.get(read)
      return Response.json(body, { status: response.status })
    }
    expect(failed(await conformance(await clientOf(showing)))).toEqual([
      ['gives a task to one of the claims that race for it, and takes its result', "a task's thread shouldn't show its claim's token"],
    ])
    // A board that takes a write under board. can't be played here: the handle the kit runs through
    // is a board() too, which refuses one before any request leaves it. The routes' own refusal is
    // checked where requests reach the board with no handle in front (test/tasks.test.ts).
  }, 60_000)

  it("fails a board that gets a batch of tasks wrong: one that makes them in turn, one that keeps part of a batch it refuses, one that forgets a batch's id, two that take an id for other tasks, one that drops what its tasks wait for, and one that answers out of order", async () => {
    const BATCH = 'makes several tasks in one write, in the order given: each waits for the ones it names, of the batch or there already, and an id makes them once'
    const ATOMIC = 'makes none of a batch when one of its tasks can not be made, wherever it comes in it'
    const failed = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.filter((check) => check.group === 'tasks' && check.status === 'failed').map((check) => [check.name, check.detail])
    const batching = (request: Request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/tasks/batch')
    type Sent = { channel: string; id?: string; tasks: { key?: string; text: string; needs?: (string | { key: string })[] }[] }
    // A board that makes a batch's tasks in turn, each with what makes one task: a task that needs a later one can't be
    // made, and it never looks at how the batch's tasks name each other.
    const turns = testBoard({ scheduler: fakeQueue().scheduler })
    const inTurn: Fetch = async (request) => {
      if (!batching(request)) return turns.fetch(request)
      const { channel, tasks } = (await request.json()) as Sent
      const made = new Map<string, string>()
      const roots: unknown[] = []
      for (const { key, needs, ...task } of tasks) {
        const waits = (needs ?? []).map((need) => (typeof need === 'string' ? need : (made.get(need.key) ?? '999999')))
        const answer = await turns.fetch(new Request(`${BOARD_URL}/tasks`, { method: 'POST', headers: request.headers, body: JSON.stringify({ channel, ...task, ...(waits.length ? { needs: waits } : {}) }) }))
        if (!answer.ok) return answer
        const { task: root } = (await answer.json()) as { task: { id: string } }
        if (key !== undefined) made.set(key, root.id)
        roots.push(root)
      }
      return Response.json({ tasks: roots }, { status: 201 })
    }
    expect(failed(await conformance(await clientOf(inTurn)))).toEqual([
      [BATCH, "needs: #999999 isn't a task"],
      [ATOMIC, 'a batch with a key two of its tasks have: expected 400 invalid_needs, and it succeeded'],
    ])
    // One that refuses what it should, with the batch's first task already written.
    const partly = testBoard({ scheduler: fakeQueue().scheduler })
    const partial: Fetch = async (request) => {
      if (!batching(request)) return partly.fetch(request)
      const sent = (await request.clone().json()) as Sent
      const response = await partly.fetch(request)
      if (response.status === 400) {
        const { key: _key, needs: _needs, ...first } = sent.tasks[0]!
        await partly.fetch(new Request(`${BOARD_URL}/tasks`, { method: 'POST', headers: request.headers, body: JSON.stringify({ channel: sent.channel, ...first }) }))
      }
      return response
    }
    expect(failed(await conformance(await clientOf(partial)))).toEqual([
      [ATOMIC, expect.stringMatching(/^a refused batch should make none of its tasks, and these are there: \["conformance: never made, first of a refused batch",/)],
    ])
    // One that drops a batch's id: a retry makes its tasks again.
    const forgetful = testBoard({ scheduler: fakeQueue().scheduler })
    const noId: Fetch = async (request) => {
      if (!batching(request)) return forgetful.fetch(request)
      const { id: _id, ...body } = (await request.json()) as Sent
      return forgetful.fetch(new Request(request, { body: JSON.stringify(body) }))
    }
    expect(failed(await conformance(await clientOf(noId)))).toEqual([[BATCH, expect.stringMatching(/^the tasks a retry with the same id answers: expected \[.+\], got \[.+\]$/)]])
    // One that finds a batch by its id whatever is asked under it: other tasks under the id get the first ones back.
    const careless = testBoard({ scheduler: fakeQueue().scheduler })
    const byIdAlone: Fetch = async (request) => {
      const url = new URL(request.url)
      if (request.method !== 'GET' || !/\/tasks\/batch\/[^/]+$/.test(url.pathname)) return careless.fetch(request)
      url.searchParams.delete('request')
      return careless.fetch(new Request(url, request))
    }
    expect(failed(await conformance(await clientOf(byIdAlone)))).toEqual([[BATCH, 'another batch under the same id: expected 409 duplicate_id, and it succeeded']])
    // And one that knows a batch by its id and its size: as many other tasks under the id get the first ones back.
    const counting = testBoard({ scheduler: fakeQueue().scheduler })
    const first = new Map<string, Sent>()
    const bySize: Fetch = async (request) => {
      // It has no way to ask whether a batch landed: every batch is sent to be made.
      if (request.method === 'GET' && /\/tasks\/batch\/[^/]+$/.test(new URL(request.url).pathname)) return Response.json({ error: { code: 'batch_not_found', message: 'no batch of yours has that id' } }, { status: 404 })
      if (!batching(request)) return counting.fetch(request)
      const body = (await request.json()) as Sent
      const before = body.id !== undefined ? first.get(body.id) : undefined
      if (body.id !== undefined && !before) first.set(body.id, body)
      return counting.fetch(new Request(request, { body: JSON.stringify(before && before.tasks.length === body.tasks.length ? before : body) }))
    }
    expect(failed(await conformance(await clientOf(bySize)))).toEqual([[BATCH, 'another plan of the same size under the same id: expected 409 duplicate_id, and it succeeded']])
    // One whose batches drop what each task waits for: every one is ready as it's made, and nothing about them is refused.
    const flat = testBoard({ scheduler: fakeQueue().scheduler })
    const noNeeds: Fetch = async (request) => {
      if (!batching(request)) return flat.fetch(request)
      const body = (await request.json()) as Sent
      return flat.fetch(new Request(request, { body: JSON.stringify({ ...body, tasks: body.tasks.map(({ needs: _needs, ...task }) => task) }) }))
    }
    expect(failed(await conformance(await clientOf(noNeeds)))).toEqual([
      [BATCH, 'a batched task that needs a later one of the batch: expected "waiting", got "ready"'],
      [ATOMIC, 'a batch with a task that needs a key no task of it has: expected 400 invalid_needs, and it succeeded'],
    ])
    // One that answers them newest first.
    const backwards = testBoard({ scheduler: fakeQueue().scheduler })
    const reversed: Fetch = async (request) => {
      const response = await backwards.fetch(request)
      if (!batching(request) || !response.ok) return response
      const body = (await response.json()) as { tasks: unknown[] }
      return Response.json({ tasks: body.tasks.reverse() }, { status: response.status })
    }
    expect(failed(await conformance(await clientOf(reversed)))).toEqual([[BATCH, expect.stringMatching(/^a batch's tasks, in the order it gave them: expected \["conformance: batched, waits for the one after it",/)]])
  }, 60_000)

  it('leaves the grants as it found them as a project, which a grant keeps in what it closes, and as a run no grant could keep in, which skips closing', async () => {
    const team = await ownPrincipals()
    const grantIds = async () => (await team.grants()).map((grant) => grant.id)
    const before = await grantIds()
    const asProject = await conformance(await clientAs(team.fetch, () => deploymentToken('v0', 'prj_v0', 'production')))
    expect(asProject.checks.filter((check) => check.group === 'grants' && check.status === 'failed')).toEqual([])
    expect(await grantIds()).toEqual(before)
    const asRun = await conformance(await clientAs(team.fetch, () => workflowToken()))
    expect(asRun.checks.filter((check) => check.detail?.startsWith('closing a pattern to everyone')).map((check) => check.name)).toEqual([
      'lets the most specific pattern decide, then the closest principal there, and adds up ties',
      'lets everyone narrow what something else lets in, and lets no one in itself',
      'makes several grants in one write, or none of them, a lock with the grant that keeps its maker in',
    ])
    expect(await grantIds()).toEqual(before)
  })

  it('makes every grant inside conformance/grants/, and no channel but the two it posts in', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const patterns: string[] = []
    // Every grant write it sends, by itself or narrowed with x-board-can, refused or not.
    const recording = (fetch: Fetch): Fetch => async (request) => {
      if (/\/grants(\/[^/]+)?$/.test(new URL(request.url).pathname) && ['POST', 'PATCH'].includes(request.method)) patterns.push(...Object.keys((await request.clone().json()).can ?? {}))
      return fetch(request)
    }
    const report = await conformance(await clientOf(recording(board.fetch)), { withCan: withCan(recording(board.fetch)) })
    expect(report.ok).toBe(true)
    expect(patterns.length).toBeGreaterThan(20)
    expect(patterns.filter((pattern) => !pattern.startsWith('conformance/grants/'))).toEqual([])
    expect((await board.channels()).channels.map((channel) => channel.path)).toEqual(['conformance', 'conformance/tasks'])
  })

  it('refuses principals that are its own before it writes anything, which the checks would change under it', async () => {
    const team = await ownPrincipals()
    const before = (await team.grants()).map((grant) => grant.id)
    const asProject = await clientAs(team.fetch, () => deploymentToken('v0', 'prj_v0', 'production'))
    await expect(conformance(asProject, { principals: { project: 'prj_v0' } })).rejects.toThrow("principals.project is this run's own project, prj_v0")
    expect((await team.channel('conformance').messages({ limit: 10 })).messages).toEqual([])
    expect((await team.grants()).map((grant) => grant.id)).toEqual(before)
    const asRun = await clientAs(team.fetch, () => workflowToken())
    await expect(conformance(asRun, { principals: { repository: 'acme/web' } })).rejects.toThrow("principals.repository is this run's own repository, acme/web")
  })

  it('fails a board that lets a caller narrowed with x-board-can grant past its can, and still revokes what that board made', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    // A board that answers as if no proxy narrowed the caller.
    const ignoring: Fetch = (request) => {
      const headers = new Headers(request.headers)
      headers.delete('x-board-can')
      return board.fetch(new Request(request, { headers }))
    }
    const report = await conformance(await clientOf(board.fetch), { withCan: withCan(ignoring) })
    const find = (name: string) => report.checks.find((check) => check.name === name)
    expect(find(GRANTS_NARROWED[1]!)).toMatchObject({ status: 'failed', detail: 'a grant on conformance/grants/ from a caller narrowed out of conformance/grants/secret/: expected 403, and it made the grant' })
    expect(find(GRANTS_NARROWED[2]!)).toMatchObject({ status: 'failed', detail: 'a grant from a caller narrowed out of conformance/grants/open/, which everyone reads: expected 403, and it made the grant' })
    expect((await board.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
    // And skips them where it can't send the header.
    const without = await conformance(await clientOf(board.fetch))
    expect(without.checks.filter((check) => GRANTS_NARROWED.includes(check.name)).map((check) => [check.status, check.detail])).toEqual(GRANTS_NARROWED.map(() => ['skipped', NO_CAN]))
  })

  it("fails a check whose grants it can't revoke", async () => {
    const stuck = testBoard({ scheduler: fakeQueue().scheduler })
    const revokes = (status: number): Fetch => async (request) =>
      request.method === 'POST' && /\/grants\/[^/]+\/revoke$/.test(new URL(request.url).pathname) ? Response.json({ error: { code: 'error', message: 'down' } }, { status }) : stuck.fetch(request)
    const report = await conformance(await clientOf(revokes(500)))
    expect(report.checks.find((check) => check.name === 'grants a principal, lists it, and revokes it')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/couldn't revoke what it made: g\d+ \(/) })
  })

  it('fails a board that lets a grant on * decide a subtree everyone is closed out of, or adds up grants across levels', async () => {
    const decides = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name.startsWith('lets the most specific pattern decide'))
    // A board whose explain says the least specific pattern decided.
    const loose = testBoard({ scheduler: fakeQueue().scheduler })
    const star = broken(loose.fetch, { body: (text) => text.replace('"pattern":"conformance/grants/closed/"', '"pattern":"*"') })
    expect(decides(await conformance(await clientOf(star)))).toMatchObject({ status: 'failed', detail: 'the pattern that decides conformance/grants/closed/thread: expected "conformance/grants/closed/", got "*"' })
    // One that says what everyone gives where a closer grant decides.
    const flat = testBoard({ scheduler: fakeQueue().scheduler })
    const everyone = broken(flat.fetch, { body: (text) => text.replace('"level":"principal"', '"level":"everyone"') })
    expect(decides(await conformance(await clientOf(everyone)))).toMatchObject({ status: 'failed', detail: expect.stringContaining('the level that decides conformance/grants/') })
  })

  it('fails a board that lets everyone in on its own', async () => {
    const find = (report: Awaited<ReturnType<typeof conformance>>, start: string) => report.checks.find((check) => check.name.startsWith(start))
    // A board whose explain gives what everyone's grant says to a principal nothing else lets in.
    const open = testBoard({ scheduler: fakeQueue().scheduler })
    const admits = broken(open.fetch, { body: (text) => (text.includes('"pattern":null') ? text.replace('"can":[]', '"can":["read"]') : text) })
    expect(find(await conformance(await clientOf(admits)), 'lets everyone narrow')).toMatchObject({ status: 'failed', detail: `what everyone's grant gives them: expected [], got ["read"]` })
  })

  it("fails a board whose inbox acks nothing, or queues a platform's retry as a new event", async () => {
    const inboxCheck = (report: Awaited<ReturnType<typeof conformance>>) => report.checks.find((check) => check.name.startsWith("queues a platform thread's events"))
    // An ack that answers ok and changes nothing: the thread's next event never comes.
    const acking = testBoard({ scheduler: fakeQueue().scheduler })
    const noAck: Fetch = async (request) =>
      request.method === 'POST' && /\/inbox\/[^/]+\/[^/]+\/ack$/.test(new URL(request.url).pathname) ? Response.json({ ok: true }) : acking.fetch(request)
    expect(inboxCheck(await conformance(await clientOf(noAck)))).toMatchObject({ status: 'failed', detail: 'the events leased from the platform thread, for message 2: expected 1, got 0' })
    // Each push under a new ID, so the platform's retry is queued again.
    const queueing = testBoard({ scheduler: fakeQueue().scheduler })
    const renamed: Fetch = async (request) => {
      if (request.method !== 'POST' || !/\/inbox\/[^/]+$/.test(new URL(request.url).pathname)) return queueing.fetch(request)
      const body = (await request.json()) as { events: { id: string }[] }
      const events = body.events.map((event) => ({ ...event, id: `${event.id}-${crypto.randomUUID()}` }))
      return queueing.fetch(new Request(request, { body: JSON.stringify({ ...body, events }) }))
    }
    expect(inboxCheck(await conformance(await clientOf(renamed)))).toMatchObject({ status: 'failed', detail: 'the events leased once both are acked: expected 0, got 1' })
  })

  it('skips the @sync check for a token that syncs elsewhere, but not where the kit posts', async () => {
    const can = { conformance: ['read', 'post', 'react', 'label'], 'elsewhere/': ['sync'] } as const
    const board = await grantingV0('production', can)
    const report = await conformance(await clientAs(board.fetch, () => deploymentToken('v0', 'prj_v0', 'production')))
    expect(report.checks.find((check) => check.name === 'hands a sync each message change as a match of its @sync watcher')).toMatchObject({
      status: 'skipped',
      detail: "this token can't sync in conformance",
    })
  })

  it('fails a board that answers only part of the protocol any other way', async () => {
    // Schedules that are missing, not refused, and files the board takes but loses.
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const partial = broken(board.fetch, { request: (url) => url.pathname.endsWith('/schedules') && (url.pathname = url.pathname.replace(/schedules$/, 'nowhere')) })
    const report = await conformance(await clientOf(partial))
    expect(report.ok).toBe(false)
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.group, check.name])).toEqual([
      ['schedules', 'schedules a reply, lists it, and cancels it'],
      ['schedules', 'keeps noSync on a schedule, so its sends stay off every platform'],
    ])
  })

  it('fails a board that shows its IDs as numbers', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const numeric = broken(board.fetch, { body: (text) => text.replace(/"(id|re)":"(\d+)"/g, '"$1":$2') })
    const report = await conformance(await clientOf(numeric))
    expect(report.ok).toBe(false)
    expect(report.checks.find((check) => check.name === 'posts a message, and reads it back by its ID')).toMatchObject({
      status: 'failed',
      detail: expect.stringContaining("a message's id should be a string of 1 to 128 characters, got 2"),
    })
  })

  it("fails a board whose reads ignore where they're asked to start", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const ignoring = broken(board.fetch, { request: (url) => url.pathname.endsWith('/messages') && url.searchParams.delete('after') })
    const report = await conformance(await clientOf(ignoring))
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.name, check.detail])).toEqual([
      ["reads one channel's messages after a cursor of its own, oldest first, and on from where it stopped", expect.stringContaining("reading on from a page's cursor should repeat none of it")],
    ])
  })

  it("fails a board whose read of a channel's messages lists more than it's asked for", async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const unlimited = broken(board.fetch, { request: (url) => url.pathname.endsWith('/messages') && url.searchParams.delete('limit') })
    const report = await conformance(await clientOf(unlimited))
    expect(report.checks.filter((check) => check.status === 'failed').map((check) => [check.name, check.detail])).toEqual([
      ["reads one channel's messages after a cursor of its own, oldest first, and on from where it stopped", expect.stringContaining('how many messages a read with a limit of 1 lists')],
      ["reads one channel's newest messages, as many as it's asked for", expect.stringContaining('a read with a limit of 2 should list 2 at most')],
    ])
  })

  it('reports finding threads by text, and reading under a pattern, as not kept here on a board that answers 501 not_supported', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const asked: string[] = []
    // A board with no index for either, as one on Vercel's API: its thread list says so.
    const unindexed: Fetch = async (request) => {
      const url = new URL(request.url)
      if (!url.pathname.endsWith('/threads') || !(url.searchParams.has('text') || url.searchParams.get('channel')?.endsWith('/'))) return board.fetch(request)
      asked.push(url.search)
      return Response.json({ error: { code: 'not_supported', message: "this board doesn't find threads that way" } }, { status: 501 })
    }
    const report = await conformance(await clientOf(unindexed))
    expect(report.ok).toBe(true)
    const search = report.checks.filter((check) => check.group === 'search')
    expect(search.map((check) => [check.status, check.detail])).toEqual([
      ['skipped', "not kept here: this board doesn't find threads that way"],
      ['skipped', "not kept here: this board doesn't find threads that way"],
    ])
    expect(asked.length).toBeGreaterThan(0)
  })

  it('fails a board whose reads ignore text', async () => {
    const board = testBoard({ scheduler: fakeQueue().scheduler })
    const ignoring = broken(board.fetch, { request: (url) => /\/(messages|threads)$/.test(url.pathname) && url.searchParams.delete('text') })
    const report = await conformance(await clientOf(ignoring))
    expect(report.checks.filter((check) => check.status === 'failed')).toEqual([
      {
        group: 'search',
        name: 'finds threads by text anywhere in a message of theirs, in any case, as it reads now',
        status: 'failed',
        detail: expect.stringContaining('the threads "DEPLOY failed" finds: expected'),
      },
    ])
  })

  it("reports a board whose discovery doesn't say where it is", async () => {
    const board = testBoard()
    const nameless = broken(board.fetch, { body: (text) => (text.includes('"audience"') ? text.replace(/"audience":"[^"]*",?/, '') : text) })
    const report = await conformance(await clientOf(nameless))
    expect(report).toMatchObject({
      ok: false,
      checks: [{ name: 'says in its discovery where it is', status: 'failed', detail: expect.stringContaining('discovery should have url, audience, and sync') }],
    })
  })
})
