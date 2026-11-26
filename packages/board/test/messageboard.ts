// An in-memory `/v1/messageboard`, as Vercel's API behaves: what
// `vercel()` from `@vercel/board/backend-vercel` is tested against. A bearer token names its principal:
// `user:u_jb`, `app:oac_1`, `project:prj_pong:production`, a GitHub Actions run's `github:repo:700001`,
// or another issuer's caller, `oidc:gitlab.com:project_path:acme/api`.
import { createHash, randomUUID } from 'node:crypto'
import { fakeGrants, GrantRefused, type Role, type Who } from './messageboard-grants.ts'
import { importedHandle, userIdOf } from '../src/contract/profiles.ts'
import { parseProfileHeader } from '../src/contract/profile-header.ts'
import { compileAccess, parseCan } from '../src/server/access.ts'
import { findBlocks } from '../src/contract/blocks.ts'
import { checkValue } from '../src/contract/data-values.ts'

type Principal =
  | { type: 'user'; userId: string }
  | { type: 'app'; clientId: string }
  | { type: 'project'; projectId: string; environment: string }
  | { type: 'github'; repositoryId: string; repository: string }
  | { type: 'oidc'; issuer: string; subject: string }
  | { type: 'external'; id: string; syncKey: string }
type Actor = {
  id: string
  principal: Principal
  /** An agent's name, or for a platform user a project's sync imported, `<key>:<user>`, with `platform` its key, that key's platform, and the user's ID. */
  profile?: { name: string; avatar?: string; platform?: { key: string; platform: string; userId: string } }
  session?: string
  /** What it may do at most, past what grants give its principal: the `x-board-can` it sent, where the API reads that. */
  can?: Record<string, 'all' | string[]>
  /** It sent an `x-board-can` the API holds it to: never its principal's integration, so no watchers or sync's records. */
  narrowed?: true
}
type Message = {
  id: string
  threadId: string
  sequence: number
  replyTo?: number
  text: string
  revision: number
  createdAt: number
  createdBy: Actor
  editedAt?: number
  deletedAt?: number
  changes: number
  reactions: Map<string, Map<string, { actor: Actor; createdAt: number }>>
  labels: Record<string, string>
  /** Its post's place in its channel's feed, which a channel cursor counts. */
  feedSequence: number
  attachments?: { id: string; name: string; type: string; size: number }[]
  schedule?: { id: string; n: number }
  /** An import's sync key, and where it is on its platform. */
  from?: string
  origin?: Record<string, unknown>
  noSync?: boolean
  links?: { url: string; message?: string | null; snapshot?: unknown; unavailable?: string | null }[]
}
type Schedule = {
  id: string
  channelId: string
  threadId?: string
  text: string
  labels?: Record<string, string>
  noSync?: boolean
  firstAt: number
  every?: number
  until?: number
  times?: number
  sent: number
  nextAt: number | null
  lastMessageId?: string
  state: 'pending' | 'done' | 'canceled'
  canceled?: { by?: Actor; at: number; reason: 'canceled' | 'revoked' | 'disabled' }
  createdAt: number
  createdBy: Actor
  revision: number
}
type Attachment = { id: string; boardId: string; name: string; type: string; size: number; sha256: string; state: 'pending' | 'ready'; messageId?: string; createdAt: number; createdBy: Actor }
type TaskState = 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'
/** A thread's task, as Vercel's API keeps it on the thread: of a claim's token, only `hash`, its SHA-256, which no answer shows. */
type Task = {
  state: TaskState
  owner: string
  /** The actor its owner made it as: itself, or one of its profiles, which is held to the tasks it made. */
  by: string
  for: string | null
  needs: string[]
  epoch: number
  claim: { actor: string; until: number; hash: string; by: Actor } | null
  blocked: { kind: string | null; reason: string } | null
  result: string | null
  reason: string | null
  /** How soon a claim of the next ready task takes it: higher first, 0 for none. */
  priority: number
  /** Who completed it, and when: a dependent readied later is readied in their name. No answer shows it. */
  completed?: { by: Actor; at: number }
  /** It completed with tasks waiting for it that haven't all been readied: whoever sees it goes on. No answer shows it. */
  marked?: true
}
type Thread = {
  id: string
  channelId: string
  messageCount: number
  lastActivityAt: number
  lastMessage?: { id: string; sequence: number; createdAt: number; createdBy: Actor }
  createdAt: number
  createdBy: Actor
  messages: Message[]
  task?: Task
}
type Change = Record<string, unknown> & { createdAt: number; messageId?: string }
/** On a platform user a project's sync imported, `via` is the project's name, or null, and its environment, and `platform` its key's platform. */
type ActorView = {
  id: string
  kind: 'person' | 'agent' | 'deployment' | 'app' | 'workflow' | 'external'
  handle: string
  name?: string
  avatar?: string
  via?: { name: string | null; environment: string }
  platform?: string
  lastSeenAt: number
}

const EMOJI = /^[a-z0-9_+-]{1,64}$/
const CHANNEL = /^[a-z0-9_-]+(\/[a-z0-9_-]+)*$/
const MESSAGE_ID = /^msg_([0-9a-f-]{36})_(\d+)$/

/** An operation ID's shape: a UUIDv7, lowercase. Its first 48 bits are when it was made, in milliseconds. */
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** How old a write's operation ID may be, and how far ahead of the API's clock, when no receipt answers it; and how long a receipt is kept. */
const OPERATION_MAX_AGE_DAYS = 7
const OPERATION_MAX_SKEW_S = 300
const RECEIPT_KEPT_DAYS = 8
const DAY_MS = 24 * 60 * 60 * 1000
/** The bytes of JSON a batch's request may be. */
const BATCH_BODY_BYTES = 65_536

class Refused extends Error {
  readonly status: number
  readonly code: string
  /** Why, for a code that says more: a lost claim's `not_claimed`, `epoch_changed`, `lease_expired`, or `token_mismatch`. */
  readonly reason: string | undefined
  /** For `task_claimed`: when the claim in the way ends, in milliseconds. */
  readonly until: number | undefined
  /** What else its error says: a batch's `items` and `limit`. */
  readonly more: Record<string, number> | undefined
  constructor(status: number, code: string, message = code, reason?: string, until?: number, more?: Record<string, number>) {
    super(message)
    this.status = status
    this.code = code
    this.reason = reason
    this.until = until
    this.more = more
  }
}

/** Vercel accounts the fake knows, by user ID: how the API names a person (their username, then their name). */
const ACCOUNTS: Record<string, { username: string; name: string }> = {
  u_jb: { username: 'julian', name: 'Ada Lovelace' },
  u_ada: { username: 'ada', name: 'Ada Lovelace' },
}

/** An issuer's host and path, as a principal's ID has it: `:` and `%` encoded. */
const issuerName = (issuer: string) => {
  const url = new URL(issuer)
  return `${url.host}${url.pathname.replace(/\/+$/, '')}`.replace(/[%:]/g, (char) => (char === '%' ? '%25' : '%3A'))
}
const principalId = (p: Principal) =>
  p.type === 'external'
    ? p.id
    : p.type === 'user'
      ? `vercel:user:${p.userId}`
      : p.type === 'app'
        ? `vercel:app:${p.clientId}`
        : p.type === 'github'
          ? `github:repo:${p.repositoryId}`
          : p.type === 'oidc'
            ? `oidc:${issuerName(p.issuer)}:${p.subject}`
            : `vercel:project:${p.projectId}:${p.environment}`
const samePrincipal = (a: Principal, b: Principal) => principalId(a) === principalId(b)
/** Whether `actor` may change what `by` wrote: its principal did, and as its profile when it writes as one. */
const owns = (actor: Actor, by: Actor) => samePrincipal(by.principal, actor.principal) && (!actor.profile || by.id === actor.id)

/**
 * Who a request is: its bearer names a principal, or is a credential `tokens` maps to one. Its
 * profile is what `x-board-profile` names, with `x-board-avatar` and `x-board-session` beside it, as
 * Vercel's API reads them today; `protocol` reads them as board's protocol has it: the profile and
 * its avatar in one structured `x-board-profile`, and the other two ignored.
 */
function actorOf(request: Request, tokens: Record<string, string> = {}, protocol = false, repositories: Record<string, string> = REPOSITORIES): Actor {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const token = tokens[bearer] ?? bearer
  const [type, id, environment] = token.split(':')
  // A run's repository as GitHub names it, and another issuer's subject, which has colons of its own.
  const repository = type === 'github' && id === 'repo' ? Object.keys(repositories).find((name) => repositories[name] === environment) : undefined
  const subject = type === 'oidc' && id ? token.slice(`oidc:${id}:`.length) : ''
  const principal: Principal | null =
    type === 'user' && id
      ? { type, userId: id }
      : type === 'app' && id
        ? { type, clientId: id }
        : type === 'project' && id && environment
          ? { type, projectId: id, environment }
          : repository
            ? { type: 'github', repositoryId: environment!, repository }
            : type === 'oidc' && subject
              ? { type: 'oidc', issuer: `https://${decodeURIComponent(id!)}`, subject }
              : null
  if (!principal) throw new Refused(401, 'invalid_token', 'This token is invalid, expired, or revoked.')
  let { name, avatar, session } = {
    name: request.headers.get('x-board-profile') ?? undefined,
    avatar: request.headers.get('x-board-avatar') ?? undefined,
    session: request.headers.get('x-board-session') ?? undefined,
  }
  if (protocol) {
    // What released clients still send, read by nothing: an avatar comes with a profile's header, and no session is kept.
    avatar = undefined
    session = undefined
    const header = request.headers.get('x-board-profile')
    if (header !== null) {
      try {
        const parsed = parseProfileHeader(header)
        ;({ name, avatar } = { name: parsed.name, avatar: parsed.avatar ?? undefined })
      } catch (error) {
        throw new Refused(400, 'invalid_profile', (error as Error).message)
      }
    }
  }
  // A proxy that holds the credential narrows it.
  const header = request.headers.get('x-board-can')
  let can: Actor['can']
  if (header !== null) {
    try {
      can = compileAccess(parseCan(header)).summary() as Actor['can']
    } catch (error) {
      throw new Refused(400, 'invalid_scope', (error as Error).message)
    }
  }
  const base = principalId(principal)
  return {
    id: name ? `${base}+${name.toLowerCase()}` : base,
    principal,
    ...(name ? { profile: { name, ...(avatar ? { avatar } : {}) } } : {}),
    ...(session ? { session } : {}),
    ...(can ? { can, narrowed: true as const } : {}),
  }
}

function page<T>(items: T[], cursor: string | null, size: number) {
  const from = cursor ? Number(cursor) : 0
  const next = from + size < items.length ? String(from + size) : null
  return { items: items.slice(from, from + size), cursor: next }
}

type Accounts = Record<string, { username: string; name: string }>

/**
 * An actor as the API names them: a person by their account, and a deployment by its project's name, in every
 * environment, or with `projectIdHandles`, as `project:<id>:<environment>`, as the API named one before. One whose
 * project it doesn't know it names that way too.
 */
function viewOf(names: Pick<Shared, 'accounts' | 'directory' | 'projectIdHandles'>, actor: Actor): Omit<ActorView, 'lastSeenAt'> {
  const p = actor.principal
  if (p.type === 'external') return { id: actor.id, kind: 'external', handle: p.id }
  // A workflow by its repository, or its token's subject, cut to fit a handle.
  if (p.type === 'github' || p.type === 'oidc') {
    const handle = p.type === 'github' ? p.repository : p.subject.slice(0, 128)
    return actor.profile ? { id: actor.id, kind: 'agent', handle: `${handle}/${actor.profile.name.toLowerCase()}`, name: actor.profile.name } : { id: actor.id, kind: 'workflow', handle }
  }
  const account = p.type === 'user' ? names.accounts[p.userId] : undefined
  const project = p.type === 'project' && !names.projectIdHandles ? names.directory.projects[p.projectId] : undefined
  const base = p.type === 'user' ? (account?.username ?? p.userId) : p.type === 'app' ? p.clientId : (project ?? `project:${p.projectId}:${p.environment}`)
  if (actor.profile?.platform) return { id: actor.id, kind: 'external', handle: actor.profile.platform.userId, platform: actor.profile.platform.platform }
  if (actor.profile) return { id: actor.id, kind: 'agent', handle: `${base}/${actor.profile.name.toLowerCase()}`, name: actor.profile.name, ...(actor.profile.avatar ? { avatar: actor.profile.avatar } : {}) }
  if (p.type === 'user') return { id: actor.id, kind: 'person', handle: base, ...(account ? { name: account.name } : {}) }
  return { id: actor.id, kind: p.type === 'app' ? 'app' : 'deployment', handle: base }
}

/** The team's people, by user ID, with their emails, and its projects and the repositories GitHub knows: what grants name. */
type Directory = { members: Record<string, string>; roles: Record<string, Role>; projects: Record<string, string>; repositories: Record<string, string>; apps: Record<string, string> }
const MEMBERS: Record<string, string> = { u_jb: 'julian@acme.com', u_ada: 'ada@acme.com', u_bob: 'bob@acme.com', u_val: 'val@acme.com' }
const ROLES: Record<string, Role> = { u_jb: 'owner', u_val: 'viewer' }
const PROJECTS: Record<string, string> = { prj_board: 'board', prj_pong: 'pong', prj_web: 'web', prj_sec: 'sec' }
const REPOSITORIES: Record<string, string> = { 'acme/web': '700001', 'acme/api': '700002' }
/** Apps installed on the team, by client ID, with their slugs. */
const APPS: Record<string, string> = { oac_1: 'ship', oac_2: 'deploy' }

/** Who a token is, as grants see it. */
const whoOf = (actor: Actor): Who => {
  // A platform user a sync imported makes no requests of their own.
  if (actor.principal.type === 'external') throw new Refused(403, 'forbidden')
  const limit = actor.can ? { limit: actor.can as NonNullable<Who['limit']> } : {}
  const p = actor.principal
  return p.type === 'user'
    ? { kind: 'user', userId: p.userId, ...limit }
    : p.type === 'project'
      ? { kind: 'project', projectId: p.projectId, environment: p.environment, ...limit }
      : p.type === 'github'
        ? { kind: 'github', repositoryId: p.repositoryId, repository: p.repository, ...limit }
        : p.type === 'oidc'
          ? { kind: 'oidc', issuer: p.issuer, claims: { sub: p.subject }, ...limit }
          : { kind: 'app', clientId: p.clientId, ...limit }
}

/**
 * What every board in one fake API shares: its team, its accounts and directory, its clock, and its bucket. `externalImports`:
 * an import's author is the platform user alone, as Vercel's API named them before platform profiles. `platformHandles`: an
 * import's handle is the platform user's own, as the API named them before it put them under their project's name. `boardWideKeys`:
 * a sync key is one registrant's on the whole board, as Vercel's API kept them before each project had its own. `projectIdHandles`:
 * a deployment's handle is `project:<id>:<environment>`, as the API named one before it named it by its project. `unscopedSync`:
 * a thread's binding goes to every registrant of its key, and `syncThread` lists every target, whose project and key they are.
 */
type Shared = {
  teamId: string
  inlineThreadMessages: boolean
  inlineTaskMessages: boolean
  channelNames: boolean
  inlineActors: boolean
  threadsLimit: boolean
  /** How many reads of a channel's feed it took: one it refused for a parameter isn't one. */
  feedReads: number
  boardFeed: boolean
  feedLast: boolean
  feedStretch: number
  threadRanges: boolean
  channelPages: boolean
  matchMessages: boolean
  accounts: Accounts
  directory: Directory
  now: () => number
  /** Notes that `actor`'s operation was answered: a retry of it is answered again, however old its ID has grown. */
  receipt: (actor: Actor, operationId: unknown) => void
  stored: Map<string, Uint8Array<ArrayBuffer>>
  externalImports: boolean
  actorsById: boolean
  namesNarrowed: boolean
  platformHandles: boolean
  boardWideKeys: boolean
  projectIdHandles: boolean
  unscopedSync: boolean
  tasks: boolean
  /** A schema the team has, by its ID: a built-in, or one it registered. */
  schemaOf: (id: string) => Record<string, unknown> | undefined
}

const STORAGE = 'http://storage.test/'

/** One board in the fake API, with its own channels, threads, files, watchers, and schedules. */
function fakeBoard(shared: Shared, boardId: string) {
  const { teamId, accounts, now, stored } = shared
  /** Its grants, g1 and g2 to start, as each board on the API has its own. */
  const access = fakeGrants({ teamId, ...shared.directory })
  const channels: { id: string; name: string }[] = [{ id: 'general', name: 'general' }]
  const threads = new Map<string, Thread>()
  const posts = new Map<string, string>()
  /** What each post's operation answered, by its caller: the API answers a repeated operation with what it answered first, and writes nothing. */
  const posted = new Map<string, unknown>()
  const once = <T,>(actor: Actor, operationId: unknown, write: () => T): T => {
    if (typeof operationId !== 'string') return write()
    const key = `${principalId(actor.principal)}|${operationId}`
    if (!posted.has(key)) {
      posted.set(key, write())
      shared.receipt(actor, operationId)
    }
    return posted.get(key) as T
  }
  const feeds = new Map<string, Change[]>()
  /** Every channel's changes in the order they were made: the board's own feed. */
  const log: Change[] = []
  /** How many changes in each channel could have made a task claimable: what wakes a claim-next that waits there. */
  const wakes = new Map<string, number>()
  const actors = new Map<string, ActorView>()
  const attachments = new Map<string, Attachment>()
  type Filter = { channelIds?: string[]; channelTree?: string; threadId?: string; authors?: string[]; text?: string; labels?: { key: string; values?: string[] }[] }
  type Registration = { owner: string; path?: string; branch?: string; watch: Record<string, { filter: Filter }>; sync: { key: string; platform: string }[]; hash: string }
  type Match = { id: string; watcher: string; threadId: string; change: Change; lease?: string; leaseUntil?: number; retryAt?: number; attempts: number }
  /** By principal, as the API keeps them: one each. */
  const registrations = new Map<string, Registration>()
  const queued = new Map<string, Match[]>()
  const schedules = new Map<string, Schedule>()
  /**
   * Sync, as Vercel's API keeps it: each key's owner, platform IDs to the board's, copies, bindings, and inboxes, all
   * under the project whose key it is (`<projectId>|…`), or the whole board's with `boardWideKeys` (`|…`).
   */
  const syncKeys = new Map<string, string>()
  const platformThreads = new Map<string, string>()
  const platformMessages = new Map<string, string>()
  const importIds = new Map<string, string>()
  /** A thread's targets: `external` is the platform thread it is there, a channel's once its root lands. `projectId` is whose. */
  const bindings = new Map<string, { target: string; targetKind: 'channel' | 'thread'; cause: string; external?: string; projectId?: string }[]>()
  /** Each message's copies, and why it didn't reach a target, by `<projectId>|<target>`. */
  const copies = new Map<string, Record<string, { thread: string; message: string; files?: string[] | null; asUser?: true }>>()
  const failures = new Map<string, Record<string, string>>()
  /** Whose sync keys a principal's are: its project's, or with `boardWideKeys`, the board's. */
  const scopeOf = (principal: Principal) => (shared.boardWideKeys || principal.type !== 'project' ? '' : principal.projectId)
  /** What a binding says of whose it is: its project, unless keys are the board's. */
  const projectOf = (principal: Principal) => (scopeOf(principal) ? { projectId: scopeOf(principal) } : {})
  type InboxEntry = { id: string; eventId: string; thread: string; event?: unknown; raw?: unknown; pushedAt: number; attempts: number; lease?: string; leaseUntil?: number; retryAt?: number; done?: boolean }
  const inboxes = new Map<string, InboxEntry[]>()

  const seen = (actor: Actor) => {
    // A platform user is named by what its sync last said of them.
    if (actor.principal.type === 'external' || actor.profile?.platform) return
    actors.set(actor.id, { ...viewOf(shared, actor), lastSeenAt: now() })
  }

  /** A channel's feed position, as the API's `c1.` cursor carries it: shared by its messages and its events. */
  const cursorAt = (channelId: string, position: number) => `c1.${position}.${channelId}`
  function positionOf(channelId: string, cursor: string): number {
    const found = /^c1\.(\d+)\.(.+)$/.exec(cursor)
    if (!found) throw new Refused(400, 'invalid_cursor')
    if (found[2] !== channelId) throw new Refused(400, 'invalid_cursor', 'Cursor belongs to another channel.')
    const position = Number(found[1])
    if (position > (feeds.get(channelId)?.length ?? 0)) throw new Refused(400, 'invalid_cursor', 'Cursor is ahead of this channel.')
    return position
  }

  /** How far back the board's feed looks for its newest events: a tree with none in that stretch answers none. */
  const FEED_LOOKBACK = 1000

  /** How many of a feed's newest events a read asks for (`last`), or null: it goes with no `cursor` or `from`, and no `wait` above 0. */
  function lastOf(url: URL): number | null {
    const asked = url.searchParams.get('last')
    if (asked === null) return null
    if (!shared.feedLast) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `last`.')
    const last = Number(asked)
    if (!Number.isInteger(last) || last < 1 || last > 100) throw new Refused(400, 'invalid_request', 'Invalid request: `last` should be an integer from 1 to 100.')
    if (url.searchParams.get('cursor') !== null || url.searchParams.get('from') !== null || Number(url.searchParams.get('wait') ?? 0) > 0)
      throw new Refused(400, 'invalid_request', "`last` reads a feed's newest events: it takes no `cursor` or `from`, and no `wait` above 0.")
    return last
  }

  /** The name of the channel a change is in, which every event of a feed says. */
  const channelNameOf = (change: Change) => channels.find((channel) => channel.id === change.channelId)?.name ?? ''

  /** A change as a read of a feed answers it: under its own cursor, with its message as it is now when asked for. */
  function changeShown(url: URL, change: Change, cursor: string) {
    const message = url.searchParams.get('include') === 'message' && change.messageId ? messageNamed(change.messageId) : undefined
    return { ...change, channel: channelNameOf(change), cursor, ...(message ? { currentMessage: show(message) } : {}) }
  }

  /**
   * The board's feed in one read: every channel's changes, or with `tree` (`dev/`) a channel's and those under it,
   * for a caller that reads every channel. Its cursor is its own, and a tree's is that tree's. A read goes
   * through one poll's worth of the feed, which may show none of it, and a wait holds through changes outside the tree.
   */
  async function boardChanges(url: URL, actor: Actor, tree: string | null, last: number | null) {
    if (!(actor.can === undefined || compileAccess(actor.can as Parameters<typeof compileAccess>[0]).readsAll) || !channels.every((channel) => mayRead(actor, channel.id)))
      throw new Refused(403, 'feed_needs_every_channel', "You can't read every channel of this board, so you can't read its feed across channels: read a channel's.")
    shared.feedReads++
    const scope = tree === null ? 'board' : `tree${createHash('sha256').update(tree).digest('hex').slice(0, 8)}`
    const at = (position: number) => `c1.${position}.${scope}`
    const cursor = url.searchParams.get('cursor')
    if (cursor !== null && url.searchParams.get('from') !== null) throw new Refused(400, 'invalid_cursor')
    let from = url.searchParams.get('from') === 'latest' ? log.length : 0
    if (cursor !== null) {
      const found = /^c1\.(\d+)\.(.+)$/.exec(cursor)
      if (!found || Number(found[1]) > log.length) throw new Refused(400, 'invalid_cursor')
      if (found[2] !== scope) throw new Refused(400, 'invalid_cursor', "Cursor belongs to another feed: a channel's, or the board's read with another `channel`.")
      from = Number(found[1])
    }
    const within = (change: Change) => {
      const name = channels.find((channel) => channel.id === change.channelId)?.name ?? ''
      return tree === null || name === tree.slice(0, -1) || name.startsWith(tree)
    }
    if (last !== null) {
      const start = Math.max(0, log.length - FEED_LOOKBACK)
      const newest = log.slice(start).flatMap((change, i) => (within(change) ? [changeShown(url, change, at(start + i + 1))] : []))
      return { events: newest.slice(-last), cursor: at(log.length), caughtUp: true }
    }
    // A read waits only at the feed's end, and for any change. Behind it, or woken by a change outside the tree, it
    // answers what it passes over, a stretch at a time: that may show nothing and stop short of the end (`caughtUp: false`).
    const until = Date.now() + Math.min(Number(url.searchParams.get('wait') ?? 0), 25) * 1000
    while (log.length <= from && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
    const include = url.searchParams.get('include') === 'message'
    const taken = log.slice(from, from + shared.feedStretch)
    const events = taken.flatMap((change, i) => {
      if (!within(change)) return []
      const message = include && change.messageId ? messageNamed(change.messageId) : undefined
      return [{ ...change, channel: channelNameOf(change), cursor: at(from + i + 1), ...(message ? { currentMessage: show(message) } : {}) }]
    })
    return { events, cursor: at(from + taken.length), caughtUp: from + taken.length >= log.length }
  }

  /** A task as every answer shows it: never its claim's token, or the hash kept of it. */
  const showTask = ({ claim, completed: _completed, marked: _marked, ...task }: Task) => ({
    ...task,
    needs: [...task.needs],
    claim: claim ? { actor: claim.actor, until: claim.until } : null,
    blocked: task.blocked ? { ...task.blocked } : null,
  })
  /** A root's labels as the API answers them: its own, and for a task, `board.task`, which is its state and no stored label. */
  const rootLabels = (t: Thread): Record<string, string> => ({ ...(t.messages[0]?.labels ?? {}), ...(t.task ? { 'board.task': t.task.state } : {}) })
  /** A message's labels as answered: a task's root wears `board.task`. */
  const labelsOf = (m: Message): Record<string, string> => (m.sequence === 1 && threads.get(m.threadId)?.task ? rootLabels(threads.get(m.threadId)!) : m.labels)
  const taskOn = (m: Message) => (m.sequence === 1 ? threads.get(m.threadId)?.task : undefined)

  const show = (m: Message) => ({
    id: m.id,
    threadId: m.threadId,
    sequence: m.sequence,
    ...(m.replyTo !== undefined ? { replyTo: m.replyTo } : {}),
    text: m.text,
    revision: m.revision,
    version: 1 + m.changes,
    createdAt: m.createdAt,
    createdBy: m.createdBy,
    ...(m.editedAt !== undefined ? { editedAt: m.editedAt } : {}),
    ...(m.deletedAt !== undefined ? { deletedAt: m.deletedAt } : {}),
    ...(m.reactions.size ? { reactions: Object.fromEntries([...m.reactions].map(([emoji, by]) => [emoji, by.size])) } : {}),
    // Up to 20 reactors an emoji, earliest first: the count is exact.
    ...(m.reactions.size ? { reactors: Object.fromEntries([...m.reactions].map(([emoji, by]) => [emoji, [...by.keys()].slice(0, 20)])) } : {}),
    ...(Object.keys(labelsOf(m)).length ? { labels: { ...labelsOf(m) } } : {}),
    ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    ...(m.schedule ? { schedule: m.schedule } : {}),
    ...(m.from !== undefined ? { from: m.from } : {}),
    ...(m.origin ? { origin: m.origin } : {}),
    ...(m.noSync ? { noSync: true } : {}),
    ...(m.links?.length ? { links: m.links } : {}),
    ...(taskOn(m) ? { task: showTask(taskOn(m)!) } : {}),
  })
  const showThread = (t: Thread) => {
    const { messages: _messages, task, ...rest } = t
    const labels = rootLabels(t)
    return { ...rest, teamId, boardId, ...(Object.keys(labels).length ? { labels } : {}), ...(task ? { task: showTask(task) } : {}) }
  }
  const meta = (m: Message) => {
    const { id, threadId, sequence, version, reactions, reactors, labels } = show(m)
    return { id, threadId, sequence, version, ...(reactions ? { reactions, reactors } : {}), ...(labels ? { labels } : {}) }
  }

  function emit(channelId: string, change: Record<string, unknown>, actor: Actor) {
    const feed = feeds.get(channelId) ?? []
    feeds.set(channelId, feed)
    const made = { id: `evt_${randomUUID()}`, channelId, actor, createdAt: now(), shard: 0, sequence: feed.length + 1, ...change } as Change
    feed.push(made)
    log.push(made)
    // A change to a task, or to a first message's labels, wakes a claim-next that waits in the channel. A post, a
    // reply, a reaction, an edit, and a label on a reply wake nobody.
    const { type, message } = change as { type: string; message?: number }
    if (type.startsWith('task.') || (type === 'message.labeled' && message === 1)) wakes.set(channelId, (wakes.get(channelId) ?? 0) + 1)
    seen(actor)
    match(made)
    return feed.length
  }

  /** What subscriber-messageboard-changes does with each event: matched against every watcher on the board. */
  function match(change: Change) {
    const messageId = (change as { messageId?: string }).messageId
    const message = messageId ? messageNamed(messageId) : undefined
    if (!message) {
      return
    }
    const queue = (owner: string, watcher: string) => {
      const lane = queued.get(owner) ?? []
      queued.set(owner, lane)
      lane.push({ id: `mat_${randomUUID()}`, watcher, threadId: message.threadId, change, attempts: 0 })
    }
    // A thread's binding goes only to the sync that owns the target's key, in the binding's project.
    const binding = (change as { binding?: { target: string; projectId?: string } }).binding
    if (change.type === 'thread.synced' && binding) {
      for (const registration of registrations.values()) {
        const project = registration.owner.split(':')[2]
        if (registration.sync.some((entry) => entry.key === prefixOf(binding.target)) && (binding.projectId === undefined || binding.projectId === project || shared.unscopedSync)) {
          queue(registration.owner, '@sync')
        }
      }
      return
    }
    const about = String(change.type)
    // A task's change is about its root, and wakes watchers like any change to it, but a renewal, which wakes none.
    const ofTask = about.startsWith('task.')
    if (!(about.startsWith('message.') || ofTask) || about === 'task.renewed') return
    const thread = threads.get(message.threadId)!
    const channel = channels.find((c) => c.id === thread.channelId)!
    const after = rootLabels(thread)
    // A task's change is matched with the root's labels before it and after it, `board.task` among them.
    const was = (change as { labels?: { 'board.task'?: { from?: string } } }).labels?.['board.task']
    const before = ofTask && was ? Object.fromEntries(Object.entries({ ...after, 'board.task': was.from }).filter(([, value]) => value !== undefined)) as Record<string, string> : after
    const scheduled = change.type === 'message.posted' && (message as { schedule?: unknown }).schedule !== undefined
    const hasLabel = (labels: Record<string, string>, { key, values }: { key: string; values?: string[] }) =>
      Object.hasOwn(labels, key) && (values === undefined || values.includes(labels[key]!))
    const sees = (filter: Filter) =>
      (filter.channelIds === undefined && filter.channelTree === undefined ? true : (filter.channelIds?.includes(channel.id) ?? false) ||
        (filter.channelTree !== undefined && (channel.name === filter.channelTree || channel.name.startsWith(`${filter.channelTree}/`)))) &&
      (filter.threadId === undefined || filter.threadId === message.threadId) &&
      (filter.authors === undefined || filter.authors.includes(message.createdBy.id) || filter.authors.includes(principalId(message.createdBy.principal))) &&
      (filter.text === undefined || message.text.toLowerCase().includes(filter.text.toLowerCase())) &&
      [after, before].some((root) => (filter.labels ?? []).every((label) => hasLabel(message.labels, label) || hasLabel(root, label)))
    // A sync gets every message change on the board as a match of its watcher `@sync`, and no task's.
    if (!ofTask)
      for (const registration of registrations.values())
        if (registration.sync.length > 0) {
          queue(registration.owner, '@sync')
        }
    for (const registration of registrations.values())
      for (const [watcher, spec] of Object.entries(registration.watch)) {
        // A watcher's own writes never wake it, but for what a schedule of its own posted.
        const own = (change.actor as Actor).id === `${registration.owner}+${watcher.toLowerCase()}`
        if ((!own || scheduled) && sees(spec.filter)) {
          queue(registration.owner, watcher)
        }
      }
  }

  const messageNamed = (id: string) => {
    const found = MESSAGE_ID.exec(id)
    return found ? threads.get(`thr_${found[1]}`)?.messages[Number(found[2]) - 1] : undefined
  }

  const threadAt = (id: string) => {
    const thread = threads.get(id)
    if (!thread) throw new Refused(404, 'thread_not_found')
    return thread
  }
  const messageAt = (threadId: string, sequence: number) => {
    const message = threadAt(threadId).messages[sequence - 1]
    if (!message) throw new Refused(404, 'message_not_found')
    return message
  }
  const channelAt = (id: string) => {
    const channel = channels.find((c) => c.id === id)
    if (!channel) throw new Refused(404, 'channel_not_found')
    return channel
  }
  /**
   * The channel a read names: by `channelId`, or, on an API that takes it, by `channel`, its name. An API from before
   * that takes no `channel`, as it takes no other parameter it doesn't know. A read makes no channel: a name no channel
   * has, or one the caller can't read, isn't there. Null when the read names none.
   */
  const channelRead = (url: URL, actor: Actor) => {
    const id = url.searchParams.get('channelId')
    const name = url.searchParams.get('channel')
    if (name === null) return id === null ? null : channelAt(id)
    if (!shared.channelNames) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `channel`.')
    if (id !== null) throw new Refused(400, 'invalid_request', 'Invalid request: should match exactly one schema in oneOf.')
    const channel = channels.find((c) => c.name === name)
    if (!channel || !mayRead(actor, channel.id)) throw new Refused(404, 'channel_not_found')
    return channel
  }
  /** `include=channel` on a message or a thread: its channel with it, on an API that takes the parameter, to a caller who may read it. */
  const withChannel = (url: URL, actor: Actor, channelId: string) => {
    const include = url.searchParams.get('include')
    if (include === null) return {}
    if (!shared.channelNames) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `include`.')
    if (include !== 'channel') throw new Refused(400, 'invalid_request')
    if (!mayRead(actor, channelId)) throw new Refused(404, 'channel_not_found')
    return { channel: channelAt(channelId) }
  }

  /** A caller narrowed with `x-board-can` does only what it gives at the channel's closest pattern: the channel, then its parents (`dev/`), then `*`. */
  function tokenMay(actor: Actor, permission: string, channelId: string) {
    tokenMayIn(actor, permission, channels.find((channel) => channel.id === channelId)?.name ?? '')
  }
  /** The same, by the channel's name, which needn't exist yet. */
  function tokenMayIn(actor: Actor, permission: string, name: string) {
    const { can } = actor
    if (!can) return
    const parts = name.split('/')
    const candidates = [name, ...parts.map((_, i) => `${parts.slice(0, parts.length - i).join('/')}/`), '*']
    const pattern = candidates.find((candidate) => Object.hasOwn(can, candidate))
    const grant = pattern === undefined ? [] : can[pattern]!
    if (!(grant === 'all' || grant.includes(permission))) throw new Refused(403, 'forbidden', `This caller may not ${permission} in ${name}.`)
  }

  /** `uploader` is who must have uploaded its files: the caller, which for an import is the sync's project, not the platform user it posts as. */
  function post(actor: Actor, thread: Thread, body: { text: string; replyTo?: number; clientId?: string; labels?: Record<string, string>; attachments?: string[]; schedule?: { id: string; n: number }; after?: number; noSync?: boolean }, uploader: Actor = actor) {
    tokenMay(actor, 'post', thread.channelId)
    // A reply's precondition, checked with the post: the thread's newest is still the one it names.
    if (body.after !== undefined && (!Number.isInteger(body.after) || body.after < 1 || body.after > thread.messageCount)) throw new Refused(400, 'invalid_after')
    if (body.after !== undefined && body.after !== thread.messageCount) throw new Refused(409, 'newer_message', `message ${thread.messageCount} came after ${body.after}`)
    // A message carries so many files, each once: the body's shape, refused before any is looked up.
    if ((body.attachments?.length ?? 0) > 10 || new Set(body.attachments).size !== (body.attachments?.length ?? 0)) throw bad('A message carries up to 10 different attachments.')
    const files = (body.attachments ?? []).map((id) => {
      const attachment = attachments.get(id)
      if (!attachment || !samePrincipal(attachment.createdBy.principal, uploader.principal)) throw new Refused(404, 'attachment_not_found')
      if (attachment.state !== 'ready') throw new Refused(409, 'attachment_not_ready')
      if (attachment.messageId) throw new Refused(409, 'attachment_already_posted')
      return attachment
    })
    // A post with attachments may have no text.
    if (typeof body.text !== 'string' || (!body.text.trim() && !(files.length && body.text === '')) || body.text.length > 10_000) throw new Refused(400, 'invalid_message', 'A message is 1 to 10000 characters.')
    if (body.replyTo !== undefined && (body.replyTo < 1 || body.replyTo > thread.messageCount)) throw new Refused(400, 'invalid_reply')
    const sequence = thread.messageCount + 1
    const createdAt = now()
    const message: Message = {
      id: `msg_${thread.id.slice('thr_'.length)}_${sequence}`,
      threadId: thread.id,
      sequence,
      ...(body.replyTo !== undefined ? { replyTo: body.replyTo } : {}),
      text: body.text,
      revision: 1,
      createdAt,
      createdBy: actor,
      changes: 0,
      reactions: new Map(),
      // A post's labels commit with it, so its event's message already has them.
      labels: { ...body.labels },
      // A root kept off every platform keeps its whole thread off, its replies too.
      ...(body.noSync || thread.messages[0]?.noSync ? { noSync: true } : {}),
      feedSequence: 0,
      ...(files.length ? { attachments: files.map(({ id, name, type, size }) => ({ id, name, type, size })) } : {}),
      ...(body.schedule ? { schedule: body.schedule } : {}),
    }
    for (const file of files) file.messageId = message.id
    thread.messages.push(message)
    thread.messageCount = sequence
    thread.lastActivityAt = createdAt
    thread.lastMessage = { id: message.id, sequence, createdAt, createdBy: actor }
    if (body.clientId) posts.set(`${principalId(actor.principal)}|${body.clientId}`, message.id)
    message.feedSequence = emit(thread.channelId, { type: 'message.posted', threadId: thread.id, message: sequence, messageId: message.id, revision: 1 }, actor)
    return message
  }

  const makeChannel = (name: unknown) => {
    if (typeof name !== 'string' || name.length > 80 || !CHANNEL.test(name)) throw new Refused(400, 'invalid_channel_name')
    if (channels.some((c) => c.name === name)) throw new Refused(409, 'channel_name_taken')
    const channel = { id: `chn_${randomUUID()}`, name }
    channels.push(channel)
    return channel
  }

  /**
   * A new thread and its first message, as a post starts one: by `channel`, its name, it checks `post` there and makes
   * the channel on its first post, as a board does; or by `channelId`. `check` runs with the channel's name before
   * anything is made, and `made` with what it answered, once the first message is posted.
   */
  function startThread<C>(actor: Actor, body: Record<string, any>, check: (channel: string) => C, made: (thread: Thread, checked: C) => void) {
    if (body.channel !== undefined) tokenMayIn(actor, 'post', String(body.channel))
    const known = body.channel !== undefined ? channels.find((c) => c.name === body.channel) : channelAt(body.channelId)
    if (known) tokenMay(actor, 'post', known.id)
    if (Object.keys(body.labels ?? {}).some((key) => key.startsWith('board.'))) throw new Refused(400, 'reserved_label', "Labels under board. are the board's own.")
    // A first message whose embedded block doesn't match the schema it names starts no thread, and makes no channel.
    for (const found of typeof body.text === 'string' && body.text.includes('json#') ? findBlocks(body.text) : []) {
      const schema = found.problem === undefined ? shared.schemaOf(found.id) : undefined
      const problem = schema ? checkValue(schema, found.data) : null
      if (problem !== null) throw new Refused(400, 'invalid_block', `The ${found.id} block doesn't match its schema: ${problem}`)
    }
    const checked = check(known?.name ?? String(body.channel))
    const channel = known ?? makeChannel(body.channel)
    const createdAt = now()
    const thread: Thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: actor, messages: [] }
    threads.set(thread.id, thread)
    const message = post(actor, thread, body as { text: string; clientId?: string; labels?: Record<string, string>; attachments?: string[]; noSync?: boolean })
    made(thread, checked)
    return { thread, message }
  }

  /** Whether `actor` may read in the channel: a narrowed caller only where its `x-board-can` gives `read`. */
  const mayRead = (actor: Actor, channelId: string) => {
    try {
      tokenMay(actor, 'read', channelId)
      return true
    } catch {
      return false
    }
  }

  /** A repeat of a post with the same client ID, by the same principal: the first one. */
  function repeat(actor: Actor, clientId: unknown) {
    if (clientId === undefined) return null
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(clientId)) throw new Refused(400, 'invalid_client_id')
    const id = posts.get(`${principalId(actor.principal)}|${clientId}`)
    if (!id) return null
    const [, uuid, sequence] = MESSAGE_ID.exec(id)!
    const thread = threadAt(`thr_${uuid}`)
    const message = thread.messages[Number(sequence) - 1]!
    if (!mayRead(actor, thread.channelId)) return { thread: { id: thread.id }, message: { id: message.id, threadId: thread.id, sequence: message.sequence } }
    return { thread: showThread(thread), message: show(message) }
  }

  // Thread tasks, as the API's wire contract says them: a thread carries task state, each change is an
  // event about its root in its channel's feed, and nothing runs outside a request.
  const THREAD_ID = /^thr_[0-9a-f-]{36}$/
  const CLAIM_TOKEN = /^[a-zA-Z0-9_-]{43}$/
  const KIND = /^[a-z0-9][a-z0-9_.-]{0,63}$/
  const LEASE_MAX_S = 300
  /** The dependents a completion readies in its own write: the rest come in writes after it, before it answers. */
  const READIED_WITH = 15
  /** How many more a completion goes over before it answers, and how many whoever goes on with one does, a request. */
  const GONE_OVER = 50
  /** The completions a claim-next that found nothing to take goes on with, oldest first. */
  const MARKED_SEEN = 3
  /** What a list or a claim-next repairs, a request at most: lapsed claims it writes as expired, and waiting tasks a list finds ready. */
  const REPAIRS = 10
  /** How many tasks a change of what a task needs walks, behind the ones it adds, to see that none waits for it. */
  const NEEDS_WALKED = 500
  /** The places a claim-next looks in at most: the channels it may claim in, times the owners it takes from. */
  const PLACES = 200
  /** How many times one claim-next looks at most: the look it starts with, the one before it waits, and up to three for each wake-up. */
  const LOOKS = 12
  /** How long after a look that a wake-up brought and that found nothing it looks again, and again: the event can come before the index has the task. */
  const LOOKS_AGAIN_MS = [200, 800]
  /** What it reads of each place, of ready tasks and of lapsed claims, and of all of them. */
  const PLACE_READS = 25
  const READY_IN_ALL = 200
  const LAPSED_IN_ALL = 50
  /** What one batch's transaction holds at most, by the count its body gives. */
  const BATCH_ITEMS = 100
  /** The feed shards a channel has: a batch's threads take a head on each they land on, eight at most. */
  const FEED_SHARDS = 8
  /** What each batch's operation answered, by its caller, with the body it was sent with. */
  const batches = new Map<string, { sent: string; key: string | null; channelId: string; tasks: ReturnType<typeof taskOf>[] }>()
  /** The batch each caller's own key made, by its caller's principal, kept for good: a digest of the request, and the threads it made. */
  const keyed = new Map<string, { digest: string; channelId: string; threads: string[] }>()
  /**
   * What makes two batch requests the same: the channel as it was named, by ID or by name, and the tasks, as many, in
   * the same order, each with the same fields. A field left out is its empty value, and the operation ID is no part of it.
   */
  const batchDigest = (body: Record<string, any>) =>
    JSON.stringify([
      body.channelId !== undefined ? { id: body.channelId } : { name: body.channel },
      (body.tasks as Record<string, any>[]).map((task) => [task.key ?? null, task.text, Object.entries(task.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)), task.noSync ?? false, task.attachments ?? [], task.needs ?? [], task.for ?? null, task.priority || 0]),
    ])
  /** A profile's name, as an actor ID ends with one. */
  const PROFILE_PART = /^[a-z0-9][a-z0-9-]{0,31}$/
  /** One of `owner`'s profiles, `<owner>+<profile>`: what a task is assigned to, never the bare owner. */
  const profileOf = (owner: string, actor: unknown) => typeof actor === 'string' && actor.startsWith(`${owner}+`) && PROFILE_PART.test(actor.slice(owner.length + 1))
  /**
   * Whether `actor` is who a task is assigned to: its owner's principal, writing as that actor. The ID alone doesn't
   * say whose it is, since another principal's own ID can end in `+<profile>` and read the same.
   */
  const assignedTo = (task: Task, actor: Actor) => task.for === actor.id && task.owner === principalId(actor.principal)
  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex')
  const bad = (message: string) => new Refused(400, 'invalid_request', message)
  const finishedFor = (task: Task) => task.state === 'completed' || task.state === 'canceled'
  /** What a change of a finished task is refused with: one code, and words that say a failed one can be reopened. */
  const finishedTask = (task: Task) =>
    new Refused(409, 'task_finished', task.state === 'failed' ? 'The task failed: reopen it to make it claimable again, or cancel it.' : 'The task is finished.')
  /** Set by a test: the next completion ends after its own write, as a request cut off there does, readying no more than fit in it. */
  let cut = false

  /**
   * What a caller may do in a channel: one narrowed with `x-board-can` at most what it gives, a viewer reading and
   * reacting, a project or an app everything but `manage`, and anyone else on the team everything.
   */
  function mayIn(actor: Actor, permission: string, name: string): boolean {
    try {
      tokenMayIn(actor, permission, name)
    } catch {
      return false
    }
    if (actor.principal.type === 'user') return (shared.directory.roles[actor.principal.userId] ?? 'member') !== 'viewer' || permission === 'read' || permission === 'react'
    return permission !== 'manage'
  }
  const may = (actor: Actor, permission: string, channelId: string) => mayIn(actor, permission, channels.find((channel) => channel.id === channelId)?.name ?? '')
  const need = (actor: Actor, permission: string, channelId: string) => {
    if (!may(actor, permission, channelId)) throw new Refused(403, 'forbidden', `You may not ${permission} there.`)
  }
  /** A thread the caller reads: one it can't is as missing as one that isn't there. */
  function readableThread(actor: Actor, id: string): Thread {
    const thread = threads.get(id)
    if (!thread || !may(actor, 'read', thread.channelId)) throw new Refused(404, 'thread_not_found')
    return thread
  }
  function taskThread(actor: Actor, id: string): Thread & { task: Task } {
    const thread = readableThread(actor, id)
    if (!thread.task) throw new Refused(404, 'not_a_task', 'That thread is not a task.')
    return thread as Thread & { task: Task }
  }
  /**
   * Whether `actor` is a task's owner, to change it or what it says: the principal that made it a task, as itself, or
   * as the profile it made it as. Another of its profiles isn't: they share a credential, so a sandbox pinned to one
   * would otherwise assign itself what another was given.
   */
  const ownedBy = (task: Task, actor: Actor) => task.owner === principalId(actor.principal) && (actor.id === task.owner || actor.id === task.by)
  /** The task's owner while it may still write there, or anyone with `manage`: what assigns, holds, unblocks, reopens, and cancels. */
  function ownerOrManage(actor: Actor, thread: Thread & { task: Task }) {
    if (may(actor, 'manage', thread.channelId)) return
    const writes = may(actor, 'post', thread.channelId) || may(actor, 'label', thread.channelId)
    if (!writes) throw new Refused(403, 'forbidden')
    if (!ownedBy(thread.task, actor)) throw new Refused(403, 'task_not_owned', 'Only its owner as itself, the profile that made it, or manage in its channel, changes a task.')
  }
  const note = (value: unknown, what: string, required: boolean): string | null => {
    if (value === undefined && !required) return null
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1000) throw bad(`${what} is 1 to 1,000 characters, not blank.`)
    return value
  }
  /** A lease as it's given: what was asked, 30 to 3,600 seconds, up to 300, and 300 when none was. */
  const leaseMs = (asked: unknown) => {
    if (asked !== undefined && !(typeof asked === 'number' && asked >= 30 && asked <= 3600)) throw bad('leaseSeconds is 30 to 3,600.')
    return Math.min((asked as number | undefined) ?? LEASE_MAX_S, LEASE_MAX_S) * 1000
  }
  const tokenOf = (value: unknown) => {
    if (typeof value !== 'string' || !CLAIM_TOKEN.test(value)) throw bad('claimToken is 32 random bytes in base64url.')
    return value
  }
  const done = (task: Task) => task.needs.every((id) => threads.get(id)?.task?.state === 'completed')
  /** How soon a task is taken, as a body says it: an integer, or nothing for 0. */
  function checkedPriority(priority: unknown): number {
    if (priority === undefined) return 0
    if (!Number.isSafeInteger(priority)) throw bad('priority is an integer.')
    return priority as number
  }

  /** One task change, as an event about the thread's root: its labels' change when its state did, and the task after it. */
  function taskEvent(thread: Thread, type: string, actor: Actor, from: TaskState | undefined, operationId: unknown) {
    const task = thread.task!
    const root = thread.messages[0]!
    root.changes++
    emit(
      thread.channelId,
      {
        type,
        threadId: thread.id,
        message: 1,
        messageId: root.id,
        // A request's own, or for what no request asked for (an expiry), one derived from what it's about.
        operationId: typeof operationId === 'string' ? operationId : `derived-${thread.id}-${task.epoch}`,
        ...(from !== task.state ? { labels: { 'board.task': { ...(from !== undefined ? { from } : {}), to: task.state } } } : {}),
        task: showTask(task),
      },
      actor,
    )
  }

  /** Writes a claim's expiry once its lease ran out, as the claimant's: whether there was one to write. */
  function expire(thread: Thread): boolean {
    const task = thread.task
    if (task?.state !== 'claimed' || task.claim!.until > now()) return false
    const by = task.claim!.by
    Object.assign(task, { state: 'ready', claim: null })
    taskEvent(thread, 'task.expired', by, 'claimed', undefined)
    return true
  }
  /**
   * Readies a waiting task whose prerequisites have all completed: a completion's dependents, or one a completion that
   * was cut off left waiting. It's whoever completed the last of them to complete that readied it, or with none on
   * record, the caller of the request that found it.
   */
  function ready(thread: Thread, actor: Actor, operationId: unknown): boolean {
    const task = thread.task
    if (task?.state !== 'waiting' || !done(task)) return false
    const last = task.needs.map((id) => threads.get(id)!.task!.completed).filter((record) => record !== undefined).sort((a, b) => b.at - a.at)[0]
    task.state = 'ready'
    taskEvent(thread, 'task.ready', last?.by ?? actor, 'waiting', operationId)
    return true
  }

  /**
   * Goes on with a completion that hasn't readied everything that waited for it, for up to `budget` tasks, as whoever
   * completed it: the mark comes off once none is left. It answers what's left of the budget.
   */
  function goOn(completed: Thread, budget: number, operationId: unknown): number {
    const task = completed.task!
    const left = [...threads.values()].filter((t) => t.task?.state === 'waiting' && t.task.needs.includes(completed.id) && done(t.task)).sort(oldestFirst)
    for (const dependent of left.slice(0, budget)) ready(dependent, task.completed!.by, operationId)
    if (left.length <= budget) delete task.marked
    return Math.max(0, budget - left.length)
  }

  /** What makes a thread a task, checked before anything is written: `self` is the thread, when it's there already. */
  /** The tasks a task waits for, checked before anything is written: tasks the caller reads, none canceled, and not `self`, the task itself. */
  function checkedNeeds(actor: Actor, needs: unknown, self: string | null): string[] {
    if (!Array.isArray(needs) || needs.length > 20 || needs.some((id) => typeof id !== 'string' || !THREAD_ID.test(id)) || new Set(needs).size !== needs.length) throw bad('needs is at most 20 thread IDs, with no repeats.')
    for (const id of needs as string[]) {
      const wanted = threads.get(id)
      if (id === self || !wanted?.task || wanted.task.state === 'canceled' || !may(actor, 'read', wanted.channelId)) throw new Refused(400, 'invalid_needs', `${id} is not a task you can wait for.`)
    }
    return needs as string[]
  }
  /**
   * Refuses prerequisites that would make task `self` wait for itself: one that waits for it already, through however
   * many tasks. Only one the change adds can close a cycle, so it walks what those need, and what those need, and
   * gives up past `NEEDS_WALKED` tasks: a change that only drops some walks nothing. A completed task's needs
   * aren't followed: they have all completed, and this task hasn't. The task itself counts like any it reaches.
   */
  function acyclic(self: string, needs: readonly string[]) {
    const from = new Map(needs.map((id) => [id, id]))
    for (let level = [...needs]; level.length > 0; ) {
      const next: string[] = []
      for (const at of level) {
        const task = threads.get(at)?.task
        if (!task || task.state === 'completed') continue
        for (const need of task.needs) {
          if (need === self) throw new Refused(400, 'invalid_needs', `${from.get(at)} waits for this task already: they would wait for each other.`)
          if (from.has(need)) continue
          from.set(need, from.get(at)!)
          next.push(need)
        }
      }
      if (from.size > NEEDS_WALKED) throw new Refused(400, 'invalid_needs', `More than ${NEEDS_WALKED} tasks are behind those: too many to check that none waits for this task.`)
      level = next
    }
  }

  function checkedTask(actor: Actor, channel: string, spec: Record<string, any>, self: string | null) {
    const owner = principalId(actor.principal)
    const needs = checkedNeeds(actor, spec.needs ?? [], self)
    const assigned: unknown = spec.for ?? null
    if (assigned !== null && !profileOf(owner, assigned)) throw new Refused(400, 'invalid_for', "A task is assigned to one of its owner's profiles.")
    const waits = needs.some((id) => threads.get(id)!.task!.state !== 'completed')
    const priority = checkedPriority(spec.priority)
    let claim: { hash: string; lease: number } | null = null
    if (spec.claim !== undefined) {
      if (typeof spec.claim !== 'object' || spec.claim === null) throw bad('claim is { claimToken, leaseSeconds? }.')
      claim = { hash: hashOf(tokenOf(spec.claim.claimToken)), lease: leaseMs(spec.claim.leaseSeconds) }
      if (!mayIn(actor, 'label', channel)) throw new Refused(403, 'forbidden', 'You may not label there.')
      // A task that can't be claimed as it would start isn't made.
      if (waits) throw new Refused(409, 'task_waiting', 'The task would wait for others.')
      if (assigned !== null && assigned !== actor.id) throw new Refused(409, 'task_assigned', 'The task would be assigned to another actor.')
    }
    return { owner, needs, for: assigned as string | null, priority, waits, claim }
  }
  function hold(thread: Thread, actor: Actor, claim: { hash: string; lease: number }, operationId: unknown) {
    const task = thread.task!
    const from = task.state
    task.epoch++
    task.state = 'claimed'
    task.claim = { actor: actor.id, until: now() + claim.lease, hash: claim.hash, by: actor }
    taskEvent(thread, 'task.claimed', actor, from, operationId)
  }
  /**
   * Whether the claim a create asked for, with `spec.claim.claimToken`, is the one that holds the task now: what both
   * create routes answer as `claimed`. A retry by client ID that sends another token doesn't, and neither does a create
   * that asked for none.
   */
  const claimedBy = (thread: Thread, spec: Record<string, any> | undefined): boolean => {
    const claim = thread.task?.claim
    const token: unknown = spec?.claim?.claimToken
    return thread.task?.state === 'claimed' && claim !== null && claim !== undefined && claim.until > now() && typeof token === 'string' && claim.hash === hashOf(token)
  }
  function makeTask(thread: Thread, actor: Actor, checked: ReturnType<typeof checkedTask>, operationId: unknown) {
    // One that needs others waits as it's made, always: when they have all completed already, its `task.ready` follows
    // in the same write, before its claim. One that needs none is ready as it's made, with no `task.ready`.
    thread.task = { state: checked.needs.length > 0 ? 'waiting' : 'ready', owner: checked.owner, by: actor.id, for: checked.for, needs: checked.needs, epoch: 0, claim: null, blocked: null, result: null, reason: null, priority: checked.priority }
    taskEvent(thread, 'task.made', actor, undefined, operationId)
    ready(thread, actor, operationId)
    if (checked.claim) hold(thread, actor, checked.claim, operationId)
  }

  /**
   * The items a batch's transaction would hold, from its body alone: the board check and the receipt, one for the
   * caller's key when it has one, a feed head for each task up to the channel's shards, six for each task, and one for
   * each label (and one more for a task with any), each attachment, each need, each different task that was there, and
   * each task whose needs are all such.
   */
  function batchItems(tasks: { labels?: Record<string, string>; attachments?: string[]; needs?: (string | { key: string })[] }[], keyed: boolean): number {
    const there = new Set(tasks.flatMap((task) => (task.needs ?? []).filter((need) => typeof need === 'string')))
    let items = 2 + (keyed ? 1 : 0) + Math.min(tasks.length, FEED_SHARDS) + there.size
    for (const task of tasks) {
      const labels = Object.keys(task.labels ?? {}).length
      const needs = task.needs ?? []
      items += 6 + labels + (labels > 0 ? 1 : 0) + (task.attachments?.length ?? 0) + needs.length + (needs.length > 0 && needs.every((need) => typeof need === 'string') ? 1 : 0)
    }
    return items
  }

  /**
   * Several threads in one channel, each started as a task, in one transaction: every refusal comes before any task is
   * written, in the order the API checks. Each task is made a millisecond after the one before it, so they list and are
   * claimed in the body's order.
   */
  function makeBatch(actor: Actor, body: Record<string, any>): { made: Thread[] } | { repeat: { channelId: string; threads: string[] } } {
    type Asked = { key?: string; text: string; labels?: Record<string, string>; noSync?: boolean; attachments?: string[]; needs?: (string | { key: string })[]; for?: string | null; priority?: number }
    const aKey = (value: unknown): value is string => typeof value === 'string' && value.length >= 1 && value.length <= 64
    // The body's shape.
    if (!Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 100) throw bad('tasks is 1 to 100 tasks.')
    if ((body.channelId === undefined) === (body.channel === undefined)) throw bad('Name the channel by channelId or by channel.')
    if (body.idempotencyKey !== undefined && (typeof body.idempotencyKey !== 'string' || body.idempotencyKey.length < 1 || body.idempotencyKey.length > 512)) throw bad('idempotencyKey is 1 to 512 characters.')
    for (const task of body.tasks as Record<string, any>[]) {
      if (typeof task !== 'object' || task === null) throw bad('A task is an object.')
      if (task.key !== undefined && !aKey(task.key)) throw bad('key is 1 to 64 characters.')
      if (task.claim !== undefined || task.clientId !== undefined) throw bad('A batch takes no claim and no clientId.')
      const needs: unknown[] = task.needs ?? []
      const named = Array.isArray(needs) ? needs.map((need) => (typeof need === 'string' && THREAD_ID.test(need) ? `task ${need}` : typeof need === 'object' && need !== null && aKey((need as { key?: unknown }).key) ? `key ${(need as { key: string }).key}` : null)) : [null]
      if (named.length > 20 || named.includes(null) || new Set(named).size !== named.length) throw bad('needs is at most 20 task IDs or keys, each named once.')
      const files: unknown[] = task.attachments ?? []
      if (!Array.isArray(files) || files.length > 10 || new Set(files).size !== files.length) throw bad('A message carries up to 10 different attachments.')
      checkedPriority(task.priority)
    }
    const tasks = body.tasks as Asked[]
    // What the caller may: post there, and label when a task has labels.
    const name = body.channel !== undefined ? String(body.channel) : channelAt(body.channelId).name
    const known = channels.find((channel) => channel.name === name)
    if (!mayIn(actor, 'post', name)) throw new Refused(403, 'forbidden', `This caller may not post in ${name}.`)
    if (tasks.some((task) => Object.keys(task.labels ?? {}).length > 0) && !mayIn(actor, 'label', name)) throw new Refused(403, 'forbidden', `This caller may not label in ${name}.`)
    // Each task's own fields, in the body's order, then a file two of them carry.
    const owner = principalId(actor.principal)
    for (const task of tasks) {
      if (typeof task.text !== 'string' || (!task.text.trim() && !(task.attachments?.length && task.text === '')) || task.text.length > 10_000) throw new Refused(400, 'invalid_message', 'A message is 1 to 10000 characters.')
      const labels = task.labels ?? {}
      if (typeof labels !== 'object' || Object.values(labels).some((value) => typeof value !== 'string')) throw new Refused(400, 'invalid_label')
      if (Object.keys(labels).some((key) => key.startsWith('board.'))) throw new Refused(400, 'reserved_label', "Labels under board. are the board's own.")
      if (Object.keys(labels).length > 16) throw new Refused(400, 'too_many_labels')
      if ((task.for ?? null) !== null && !profileOf(owner, task.for)) throw new Refused(400, 'invalid_for', "A task is assigned to one of its owner's profiles.")
    }
    const carried = tasks.flatMap((task) => task.attachments ?? [])
    if (new Set(carried).size !== carried.length) throw new Refused(400, 'invalid_attachments', 'Two tasks carry the same attachment.')
    // How the batch's tasks wait for each other.
    const places = new Map<string, number>()
    for (const [at, task] of tasks.entries()) {
      if (task.key === undefined) continue
      if (places.has(task.key)) throw new Refused(400, 'invalid_needs', `Two tasks have the key ${task.key}.`)
      places.set(task.key, at)
    }
    const inside = tasks.map((task, at) =>
      (task.needs ?? []).flatMap((need) => {
        if (typeof need === 'string') return []
        const found = places.get(need.key)
        if (found === undefined) throw new Refused(400, 'invalid_needs', `No task has the key ${need.key}.`)
        if (found === at) throw new Refused(400, 'invalid_needs', `The task with the key ${need.key} needs itself.`)
        return [found]
      }),
    )
    const settled = new Set<number>()
    for (let left = tasks.length; left > 0; ) {
      const next = tasks.flatMap((_, at) => (!settled.has(at) && inside[at]!.every((other) => settled.has(other)) ? [at] : []))
      if (next.length === 0) throw new Refused(400, 'invalid_needs', 'Tasks of the batch wait for each other.')
      for (const at of next) settled.add(at)
      left -= next.length
    }
    // What fits one transaction, by the body's count, and one kept answer.
    const items = batchItems(tasks, body.idempotencyKey !== undefined)
    if (items > BATCH_ITEMS) throw new Refused(400, 'batch_too_large', `This batch takes ${items} items, and a transaction holds ${BATCH_ITEMS}: send it in parts.`, undefined, undefined, { items, limit: BATCH_ITEMS })
    // The caller's own key, its principal's on this board, before anything about the batch is read: the same request
    // under it stops here with what the first made, checked against nothing as it is by now, and another is refused.
    const named = body.idempotencyKey !== undefined ? `${owner}|${body.idempotencyKey}` : null
    const digest = batchDigest(body)
    const landed = named !== null ? keyed.get(named) : undefined
    if (landed && landed.digest !== digest) throw new Refused(409, 'idempotency_key_reused', 'That key made another batch: another channel, or other tasks.')
    if (landed) return { repeat: landed }
    // What takes a read, in the API's order. A caller narrowed to channels is first told of a task it can't read there.
    const wanted = tasks.map((task) => (task.needs ?? []).filter((need) => typeof need === 'string'))
    if (actor.can) for (const id of wanted.flat()) if (threads.has(id) && !mayRead(actor, threads.get(id)!.channelId)) throw new Refused(400, 'invalid_needs', `${id} is not a task you can wait for.`)
    for (const task of tasks)
      for (const found of task.text.includes('json#') ? findBlocks(task.text) : []) {
        const schema = found.problem === undefined ? shared.schemaOf(found.id) : undefined
        const problem = schema ? checkValue(schema, found.data) : null
        if (problem !== null) throw new Refused(400, 'invalid_block', `The ${found.id} block doesn't match its schema: ${problem}`)
      }
    const there = wanted.map((needs) => checkedNeeds(actor, needs, null))
    // A batch by a channel's name makes the channel once all but its files have passed, as one task by name does: only a
    // batch refused for a file leaves a channel behind.
    const channel = known ?? makeChannel(name)
    for (const id of carried) {
      const attachment = attachments.get(id)
      if (!attachment || !samePrincipal(attachment.createdBy.principal, actor.principal)) throw new Refused(404, 'attachment_not_found')
      if (attachment.state !== 'ready') throw new Refused(409, 'attachment_not_ready')
      if (attachment.messageId) throw new Refused(409, 'attachment_already_posted')
    }
    // The write: each task, a millisecond after the one before.
    const first = now()
    const made = tasks.map((_, at): Thread => ({ id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: first + at, createdAt: first + at, createdBy: actor, messages: [] }))
    for (const [at, task] of tasks.entries()) {
      const thread = made[at]!
      threads.set(thread.id, thread)
      const message = post(actor, thread, { text: task.text, ...(task.labels ? { labels: task.labels } : {}), ...(task.attachments?.length ? { attachments: task.attachments } : {}), ...(task.noSync ? { noSync: true } : {}) })
      message.createdAt = thread.lastActivityAt = first + at
      thread.lastMessage = { ...thread.lastMessage!, createdAt: first + at }
      makeTask(thread, actor, { owner, needs: [...there[at]!, ...inside[at]!.map((other) => made[other]!.id)], for: task.for ?? null, priority: task.priority || 0, waits: false, claim: null }, body.operationId)
    }
    if (named !== null) keyed.set(named, { digest, channelId: channel.id, threads: made.map((thread) => thread.id) })
    return { made }
  }

  /** Refuses a write whose claim doesn't hold the task now, saying why. */
  function fenced(thread: Thread & { task: Task }, actor: Actor, body: Record<string, any>) {
    const token = tokenOf(body.claimToken)
    if (!Number.isInteger(body.epoch) || body.epoch < 1) throw bad('epoch is the claim\'s.')
    need(actor, 'label', thread.channelId)
    const { task } = thread
    // The fence is the task's state, its epoch, the claim's token, and its lease, never who asks: whatever else the
    // task is, a finished one included, a claim that doesn't hold it is lost.
    const lost = (reason: string) => new Refused(409, 'claim_lost', 'That claim is not the task\'s.', reason)
    if (task.state !== 'claimed') throw lost('not_claimed')
    if (task.epoch !== body.epoch) throw lost('epoch_changed')
    if (task.claim!.until <= now()) throw lost('lease_expired')
    if (task.claim!.hash !== hashOf(token)) throw lost('token_mismatch')
  }

  /** The root ties: deleting a task's root cancels it, and an edit by anyone but its owner holds it. */
  function rootDeleted(thread: Thread, actor: Actor) {
    const task = thread.task
    if (!task || finishedFor(task)) return
    expire(thread)
    const from = task.state
    Object.assign(task, { state: 'canceled', claim: null, blocked: null, reason: 'deleted' })
    taskEvent(thread, 'task.canceled', actor, from, undefined)
  }
  function rootEdited(thread: Thread, actor: Actor) {
    const task = thread.task
    // Its owner is the principal that made it a task, as itself or as the profile it made it as: another of its
    // profiles isn't. Nor is a platform user a sync imported, though they write as a profile of the project whose sync
    // speaks for them: the edit is theirs, made elsewhere.
    const platformUser = actor.principal.type === 'external' || actor.profile?.platform !== undefined
    const owner = task !== undefined && ownedBy(task, actor) && !platformUser
    if (!task || owner || !['waiting', 'ready', 'claimed'].includes(task.state)) return
    expire(thread)
    const from = task.state
    Object.assign(task, { state: 'blocked', claim: null, blocked: { kind: 'edited', reason: 'Its root was edited by someone who does not own the task.' } })
    taskEvent(thread, 'task.blocked', actor, from, undefined)
  }

  /** The channels a claim-next or a list names: one by its name, or `prefix/` for it and every one under it. */
  const channelsNamed = (name: string) => (name.endsWith('/') ? channels.filter((c) => c.name === name.slice(0, -1) || c.name.startsWith(name)) : channels.filter((c) => c.name === name))
  const oldestFirst = (a: Thread, b: Thread) => a.createdAt - b.createdAt
  /** The higher priority first, then the oldest: the order a claim-next takes ready tasks in. */
  const byPriority = (a: Thread, b: Thread) => b.task!.priority - a.task!.priority || oldestFirst(a, b)

  /** The oldest ready task there the caller takes: one assigned to its actor first, then an unassigned one it owns or `from` names. */
  function claimNext(actor: Actor, body: Record<string, any>, claim: { hash: string; lease: number }, share: { expiries: number; goneOver: number; looks: number; first: boolean }): Thread | null {
    const named = channelsNamed(String(body.channel))
    // Channels where the caller lacks `label` are skipped: with it in none, there's nothing it claims. The limit counts those it may claim in.
    const labeled = named.filter((channel) => may(actor, 'label', channel.id))
    if (named.length > 0 && labeled.length === 0) throw new Refused(403, 'forbidden', 'You may not label there.')
    if (labeled.length > 50) throw new Refused(400, 'channel_tree_too_large', 'Name a prefix with at most 50 channels you may claim in under it.')
    // It looks only at what the caller may take: in each channel, one place for each owner it takes unassigned tasks
    // from, its own principal and each other one `from` names, and with a profile, one for what's assigned to its actor.
    const self = principalId(actor.principal)
    const owners = [self, ...new Set(((body.from ?? []) as string[]).filter((owner) => owner !== self))]
    if (labeled.length * (owners.length + (actor.profile ? 1 : 0)) > PLACES) throw new Refused(400, 'claim_too_wide', `Name fewer owners or a smaller tree: this would look in more than ${PLACES} places.`)
    const wanted = Object.entries((body.labels ?? {}) as Record<string, string>)
    const places = labeled.flatMap((channel) => {
      const tasks = [...threads.values()].filter((t) => t.channelId === channel.id && t.task)
      return [...owners.map((owner) => tasks.filter((t) => t.task!.for === null && t.task!.owner === owner)), ...(actor.profile ? [tasks.filter((t) => assignedTo(t.task!, actor))] : [])]
    })
    const lapsed = (t: Thread) => t.task!.state === 'claimed' && t.task!.claim!.until <= now()
    const longestLapsed = (a: Thread, b: Thread) => a.task!.claim!.until - b.task!.claim!.until
    /** What's assigned to the caller's actor first, then in `order`. */
    const assignedFirst = (order: (a: Thread, b: Thread) => number) => (a: Thread, b: Thread) => Number(assignedTo(b.task!, actor)) - Number(assignedTo(a.task!, actor)) || order(a, b)
    const look = () => {
      share.looks++
      // From each place, its oldest ready tasks and its claims whose lease ran out longest ago, a few of each, and of
      // all those a bounded number, the assigned ones first. Each is the caller's to take, so only `labels` narrow them.
      const ready = places.flatMap((tasks) => tasks.filter((t) => t.task!.state === 'ready').sort(byPriority).slice(0, PLACE_READS)).sort(assignedFirst(byPriority)).slice(0, READY_IN_ALL)
      const over = places.flatMap((tasks) => tasks.filter(lapsed).sort(longestLapsed).slice(0, PLACE_READS)).sort(assignedFirst(longestLapsed)).slice(0, LAPSED_IN_ALL)
      const mine = [...ready, ...over].filter((t) => wanted.every(([key, value]) => rootLabels(t)[key] === value)).sort(assignedFirst(byPriority))
      return { found: mine[0] ?? null, over }
    }
    let { found, over } = look()
    const first = share.first
    share.first = false
    if (!found && first) {
      // Nothing to take: once a request, it goes on with the completions on the board that haven't readied everything
      // that waited for them, the oldest few, wherever they and what waited are, and looks again when that readied
      // any. It looks through no waiting task itself.
      const before = share.goneOver
      const marked = [...threads.values()].filter((t) => t.task?.marked).sort((a, b) => a.task!.completed!.at - b.task!.completed!.at).slice(0, MARKED_SEEN)
      for (const completed of marked) share.goneOver = goOn(completed, share.goneOver, undefined)
      if (share.goneOver < before) ({ found, over } = look())
    }
    // The lapsed claims it found are ended, a few a request, beside the one it takes over, whose expiry goes with its
    // claim. One on a task that isn't the caller's to take it never read, so it leaves it.
    for (const thread of over) if (thread !== found && share.expiries > 0 && expire(thread)) share.expiries--
    if (found) {
      expire(found)
      hold(found, actor, claim, body.operationId)
    }
    return found
  }

  /**
   * What each claim-next claimed, by its caller and operation, with the hash of the token it claimed with. One that
   * claimed nothing wrote nothing, so the same operation looks again.
   */
  const claimed = new Map<string, { thread: Thread; hash: string }>()

  /** A task's state as every task route answers it: a claim whose lease ran out is over, whether or not its expiry is written. */
  const live = (task: Task): TaskState => (task.state === 'claimed' && task.claim!.until <= now() ? 'ready' : task.state)
  /**
   * A task as the task routes answer it: the thread's ID, its state at the top, and its first message as the message
   * routes answer it, without its `task`. A claim whose lease ran out reads as over here.
   */
  function taskOf(thread: Thread) {
    const task = thread.task!
    const state = live(task)
    const { task: _facet, ...message } = show(thread.messages[0]!)
    return {
      id: thread.id,
      channelId: thread.channelId,
      ...showTask(task),
      state,
      claim: state === task.state ? showTask(task).claim : null,
      message: { ...message, labels: { ...message.labels, 'board.task': state } },
      messageCount: thread.messageCount,
      lastActivityAt: thread.lastActivityAt,
      ...(thread.lastMessage ? { lastMessage: thread.lastMessage } : {}),
    }
  }

  /**
   * The task routes, version 2 of them: `/tasks…`, each answering `{ task }`. Undefined for a route that isn't one.
   * `signal` aborts when the request's response closes.
   */
  function taskRoute(method: string, rest: string, url: URL, body: Record<string, any>, actor: Actor, signal?: AbortSignal): unknown {
    const answer = (thread: Thread) => ({ task: taskOf(thread) })
    if (method === 'GET' && rest === '/tasks') return listTasks(url, actor)
    if (method === 'POST' && rest === '/tasks/claim') {
      const key = `${principalId(actor.principal)}|${body.operationId}`
      const claim = { hash: hashOf(tokenOf(body.claimToken)), lease: leaseMs(body.leaseSeconds) }
      if (typeof body.channel !== 'string' || !/^[a-z0-9_-]+(\/[a-z0-9_-]+)*\/?$/.test(body.channel)) throw bad('channel is a channel, or a prefix and a slash.')
      if (body.from !== undefined && !(Array.isArray(body.from) && body.from.length <= 32 && body.from.every((id: unknown) => typeof id === 'string'))) throw bad('from is at most 32 owner IDs.')
      if (body.wait !== undefined && !(typeof body.wait === 'number' && body.wait >= 0 && body.wait <= 25)) throw bad('wait is 0 to 25 seconds.')
      const until = Date.now() + (body.wait ?? 0) * 1000
      // What one request spends on what it finds undone, and how often it has looked.
      const share = { expiries: REPAIRS, goneOver: GONE_OVER, looks: 0, first: true }
      const nothing = { task: null }
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
      /** How many changes that could make a task claimable the channels it names have seen. */
      const woken = () => channelsNamed(body.channel).reduce((sum, channel) => sum + (wakes.get(channel.id) ?? 0), 0)
      /** One look, and the claim it took: its answer, or undefined for nothing to take. */
      const look = () => {
        // Once the operation claimed, a retry with its token answers that claim, as it was made, and any other token is
        // refused. It answers it only while the caller may still claim in the task's channel, one the request names:
        // otherwise nothing, as for a channel it can't claim in.
        const prior = claimed.get(key)
        if (prior && prior.hash !== claim.hash) throw new Refused(409, 'operation_conflict', 'That operation claimed with another token.')
        if (prior) return may(actor, 'label', prior.thread.channelId) && channelsNamed(body.channel).some((channel) => channel.id === prior.thread.channelId) ? answer(prior.thread) : nothing
        // A client that went away is claimed nothing new for: it looks at that before each look.
        if (signal?.aborted) return nothing
        const found = claimNext(actor, body, claim, share)
        if (!found) return undefined
        claimed.set(key, { thread: found, hash: claim.hash })
        shared.receipt(actor, body.operationId)
        return answer(found)
      }
      return (async () => {
        // The look it starts with.
        const started = look()
        if (started || !(body.wait > 0)) return started ?? nothing
        for (let woke = false; ; woke = true) {
          // What it's woken by is watched before it looks again, so a task that turns ready in between wakes it.
          const seen = woken()
          // The look before it waits, or the one a wake-up brings. That one is followed by two more, a little apart,
          // when it finds nothing: the event can come before the index has the task.
          let answered = look()
          for (const after of woke ? LOOKS_AGAIN_MS : []) {
            const left = until - Date.now()
            if (answered || left <= 0 || share.looks >= LOOKS) break
            await pause(Math.min(after, left))
            answered = look()
          }
          if (answered) return answered
          // Out of time, or out of looks: with those spent it answers nothing, though its wait isn't up.
          if (Date.now() >= until || share.looks >= LOOKS) return nothing
          // It waits for a change in a channel it names that can make a task claimable, or for its wait to run out.
          while (woken() === seen && Date.now() < until && !signal?.aborted) await pause(10)
          if (signal?.aborted) return nothing
          // A wait that ran out looks once more: a lease that ran out, or a grant, makes a task claimable with no event.
          if (woken() === seen) return look() ?? nothing
        }
      })()
    }
    if (method === 'POST' && rest === '/tasks') {
      // With a claim asked for, whether its token holds the task as this answers: a retry is told anew.
      const told = <T extends { task: { id: string } }>(made: T) => (body.claim !== undefined ? { ...made, claimed: claimedBy(threadAt(made.task.id), body) } : made)
      // A thread that's there, made a task as it is.
      if (body.threadId !== undefined) {
        return told(
          once(actor, body.operationId, () => {
            const thread = readableThread(actor, String(body.threadId))
            need(actor, 'label', thread.channelId)
            if (thread.task) throw new Refused(409, 'already_a_task', 'That thread is a task already.')
            if (thread.messages[0]!.deletedAt !== undefined) throw new Refused(409, 'message_deleted', "That thread's first message was deleted.")
            makeTask(thread, actor, checkedTask(actor, channelAt(thread.channelId).name, body, thread.id), body.operationId)
            return answer(thread)
          }),
        )
      }
      // A post that landed under this client ID is answered as the task it is now, and claims nothing: one that's no task isn't one.
      const again = repeat(actor, body.clientId)
      if (again) {
        const thread = threadAt(again.thread.id)
        // A thread that isn't a task, or a reply, in a task's thread or not: for a caller that can't read it too.
        if (!thread.task || again.message.sequence !== 1) throw new Refused(404, 'not_a_task', 'That client ID names a post that is no task.')
        // To a caller that can't read its channel, its ID and nothing else: it can't have asked for a claim, since `label` brings `read`.
        return mayRead(actor, thread.channelId) ? told(answer(thread)) : { task: { id: thread.id } }
      }
      let made = false
      const first = once(actor, body.operationId, () => {
        // What it can't be is refused before its channel or its first message is made.
        const { thread } = startThread(actor, body, (channel) => checkedTask(actor, channel, body, null), (started, checked) => makeTask(started, actor, checked, body.operationId))
        made = true
        return answer(thread)
      })
      // Only the request that made the task answers it whole to a caller that can't read its channel: a retry of the
      // operation answers its ID alone, as a replay by client ID does.
      if (!made && !mayRead(actor, first.task.channelId)) return { task: { id: first.task.id } }
      return told(first)
    }
    if (method === 'POST' && rest === '/tasks/batch') {
      const key = `${principalId(actor.principal)}|${body.operationId}`
      // What the request asks for, whichever attempt sends it: its body but the operation ID.
      const { operationId: _attempt, ...asked } = body
      const sent = JSON.stringify(asked)
      // The operation again answers the tasks as the first call answered them, and another body under it is refused: the
      // caller's key is part of what an operation stands for, so another key, or none where it had one, is another body.
      // The same key under it is answered by the key.
      const first = batches.get(key)
      const named = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : null
      if (first && (first.key !== named || (named === null && first.sent !== sent))) throw new Refused(409, 'operation_conflict', 'That operation made other tasks.')
      // To a caller that can't read the channel, only the call that made them answers them whole.
      if (first && named === null) return { tasks: mayRead(actor, first.channelId) ? first.tasks : first.tasks.map(({ id }) => ({ id })) }
      const batch = makeBatch(actor, body)
      // The key again, with the same request: the tasks it made, as they are now, and their IDs alone to a caller that can't read them.
      if ('repeat' in batch) return { tasks: batch.repeat.threads.map((id) => (mayRead(actor, batch.repeat.channelId) ? taskOf(threadAt(id)) : { id })) }
      const answered = { sent, key: named, channelId: batch.made[0]!.channelId, tasks: batch.made.map(taskOf) }
      batches.set(key, answered)
      shared.receipt(actor, body.operationId)
      return { tasks: answered.tasks }
    }
    const worked = /^\/tasks\/([^/]+)\/(claim|renew|release|complete|fail|block|unblock|reopen|assign|needs|priority|cancel)$/.exec(rest)
    if (method !== 'POST' || !worked) return undefined
    const verb = worked[2]!
    let wrote = false
    const answered = once(actor, body.operationId, () => {
      wrote = true
      // A change of needs is refused for its body's shape before anything about the task: up to 100 thread IDs, repeats among them.
      if (verb === 'needs' && (!Array.isArray(body.needs) || body.needs.length > 100 || body.needs.some((id: unknown) => typeof id !== 'string' || !THREAD_ID.test(id)))) throw bad('needs is up to 100 thread IDs.')
      const thread = taskThread(actor, decodeURIComponent(worked[1]!))
      const { task } = thread
      let from = task.state
      const op = body.operationId
      /** A claim whose lease ran out is over for whoever changes the task next: its expiry is written first, in the same write. */
      const lapse = () => {
        if (expire(thread)) from = task.state
      }
      if (verb === 'claim') {
        const claim = { hash: hashOf(tokenOf(body.claimToken)), lease: leaseMs(body.leaseSeconds) }
        need(actor, 'label', thread.channelId)
        const lapsed = task.state === 'claimed' && task.claim!.until <= now()
        if (task.state === 'waiting' && !done(task)) throw new Refused(409, 'task_waiting', 'The task waits for others.')
        if (task.state === 'blocked') throw new Refused(409, 'task_blocked', 'The task is held for a person.')
        if (finishedFor(task) || task.state === 'failed') throw finishedTask(task)
        if (task.for !== null && !assignedTo(task, actor)) throw new Refused(409, 'task_assigned', 'The task is assigned to another actor.')
        if (task.state === 'claimed' && !lapsed) throw new Refused(409, 'task_claimed', 'Someone holds the task.', undefined, task.claim!.until)
        // What it found to repair goes in the same write as the claim: a lapsed lease's expiry, or a readying that was cut off.
        expire(thread)
        ready(thread, actor, op)
        hold(thread, actor, claim, op)
      } else if (verb === 'renew') {
        const lease = leaseMs(body.leaseSeconds)
        fenced(thread, actor, body)
        task.claim!.until = now() + lease
        taskEvent(thread, 'task.renewed', actor, from, op)
      } else if (verb === 'release') {
        fenced(thread, actor, body)
        Object.assign(task, { state: 'ready', claim: null })
        taskEvent(thread, 'task.released', actor, from, op)
      } else if (verb === 'complete') {
        const result = note(body.result, 'result', false)
        fenced(thread, actor, body)
        Object.assign(task, { state: 'completed', claim: null, result, completed: { by: actor, at: now() } })
        taskEvent(thread, 'task.completed', actor, from, op)
        // The tasks that waited only for it: 15 in its own write, up to 50 more before it answers, and any left to
        // whoever sees it marked. It answers 200 whether or not it got to every one.
        task.marked = true
        goOn(thread, cut ? READIED_WITH : READIED_WITH + GONE_OVER, op)
        cut = false
      } else if (verb === 'fail') {
        const reason = note(body.reason, 'reason', true)
        fenced(thread, actor, body)
        Object.assign(task, { state: 'failed', claim: null, reason })
        taskEvent(thread, 'task.failed', actor, from, op)
      } else if (verb === 'block') {
        const reason = note(body.reason, 'reason', true)
        if (body.kind !== undefined && (typeof body.kind !== 'string' || !KIND.test(body.kind))) throw bad('kind is up to 64 lowercase letters, numbers, and _.-')
        if (body.kind === 'edited') throw new Refused(400, 'invalid_request', 'edited is the kind of a hold the API places itself.')
        if ((body.claimToken === undefined) !== (body.epoch === undefined)) throw new Refused(400, 'invalid_request', 'A claim is its claimToken and its epoch: send both, or neither.')
        if (body.claimToken !== undefined) fenced(thread, actor, body)
        else {
          ownerOrManage(actor, thread)
          lapse()
          if (task.state === 'claimed') throw new Refused(409, 'task_claimed', 'Someone holds the task: only its claim holds it for a person.')
          if (task.state === 'blocked') throw new Refused(409, 'task_blocked', 'The task is held already.')
          if (finishedFor(task) || task.state === 'failed') throw finishedTask(task)
        }
        Object.assign(task, { state: 'blocked', claim: null, blocked: { kind: body.kind ?? null, reason } })
        taskEvent(thread, 'task.blocked', actor, from, op)
      } else if (verb === 'unblock') {
        ownerOrManage(actor, thread)
        // A finished task has no hold to lift, a failed one included.
        if (finishedFor(task) || task.state === 'failed') throw finishedTask(task)
        lapse()
        if (task.state === 'blocked') {
          // One that needs others waits again, always: when they have all completed, its `task.ready` follows in the same
          // write. One that needs none is ready in the unblock itself.
          Object.assign(task, { state: task.needs.length > 0 ? 'waiting' : 'ready', blocked: null })
          taskEvent(thread, 'task.unblocked', actor, from, op)
          ready(thread, actor, op)
        }
      } else if (verb === 'reopen') {
        ownerOrManage(actor, thread)
        // A completed or canceled task stays finished; an open one is answered as it is.
        if (finishedFor(task)) throw finishedTask(task)
        lapse()
        if (task.state === 'failed') {
          Object.assign(task, { state: 'ready', reason: null })
          taskEvent(thread, 'task.reopened', actor, from, op)
        }
      } else if (verb === 'assign') {
        ownerOrManage(actor, thread)
        const assigned: unknown = body.for
        if (!(assigned === null || profileOf(task.owner, assigned))) throw new Refused(400, 'invalid_for', "A task is assigned to one of its owner's profiles.")
        const to = assigned as string | null
        if (finishedFor(task) || task.state === 'failed') throw finishedTask(task)
        lapse()
        if (task.for !== to) {
          task.for = to
          taskEvent(thread, 'task.assigned', actor, from, op)
        }
      } else if (verb === 'priority') {
        ownerOrManage(actor, thread)
        const priority = checkedPriority(body.priority ?? null)
        // A claim was taken on what it says, not on how soon: it changes under one, and a finished task's stays.
        if (finishedFor(task) || task.state === 'failed') throw finishedTask(task)
        if (task.priority !== priority) {
          task.priority = priority
          taskEvent(thread, 'task.priority_changed', actor, from, op)
        }
      } else if (verb === 'needs') {
        ownerOrManage(actor, thread)
        if (finishedFor(task) || task.state === 'failed') throw finishedTask(task)
        if (task.state === 'claimed' && task.claim!.until > now()) throw new Refused(409, 'task_claimed', 'Someone holds the task: what it needs changes once no one does.', undefined, task.claim!.until)
        // The set as given, however often each task is named: 20 different tasks at most, each one the caller can wait for.
        const named = body.needs as string[]
        const set = [...new Set(named)]
        if (set.length > 20) throw new Refused(400, 'invalid_needs', 'A task waits for 20 tasks at most.')
        const needs = checkedNeeds(actor, set, thread.id)
        // The same set changes nothing: not even a lapsed claim's expiry is written for it.
        if (needs.length !== task.needs.length || needs.some((id) => !task.needs.includes(id))) {
          // Another set names each task once.
          if (set.length !== named.length) throw new Refused(400, 'invalid_needs', 'A task is named once among what another waits for.')
          acyclic(thread.id, needs.filter((id) => !task.needs.includes(id)))
          lapse()
          // It waits for them from this write, and its `task.ready` follows in it when they have all completed: with
          // none it's ready, and one held for a person stays held.
          task.needs = needs
          if (task.state !== 'blocked') task.state = needs.length > 0 ? 'waiting' : 'ready'
          taskEvent(thread, 'task.needs_changed', actor, from, op)
          ready(thread, actor, op)
        }
      } else {
        const reason = note(body.reason, 'reason', true)
        ownerOrManage(actor, thread)
        if (finishedFor(task)) throw finishedTask(task)
        lapse()
        Object.assign(task, { state: 'canceled', claim: null, blocked: null, reason })
        taskEvent(thread, 'task.canceled', actor, from, op)
      }
      return answer(thread)
    })
    // A retry of a completion answers what the first call did, and goes on with what it left unreadied.
    const again = wrote || verb !== 'complete' ? undefined : threads.get(decodeURIComponent(worked[1]!))
    if (again?.task?.marked) goOn(again, GONE_OVER, body.operationId)
    return answered
  }

  /**
   * `GET /tasks`: tasks oldest first. A page is the next 25 tasks in the states and the channel (or board) it reads,
   * and every other filter applies after that, so a page can come back short.
   */
  function listTasks(url: URL, actor: Actor) {
    const query = (name: string) => url.searchParams.get(name)
    const include = query('include')
    // An API from before `include=messages` takes no `include`, as it takes no other parameter it doesn't know.
    if (include !== null && !shared.inlineTaskMessages) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `include`.')
    if (include !== null && include !== 'messages') throw new Refused(400, 'invalid_request')
    const wanted = query('state') ?? 'open'
    const states: TaskState[] | null = wanted === 'all' ? null : wanted === 'open' ? ['waiting', 'ready', 'claimed', 'blocked'] : ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled'].includes(wanted) ? [wanted as TaskState] : []
    if (states?.length === 0) throw bad('state is open, all, or a state.')
    if (query('channelId') !== null && query('channel') !== null) throw new Refused(400, 'invalid_request', 'Name a channel by its ID or its name, not both.')
    const named = query('channel')
    // Whoever reads the whole board lists it as it is. Anyone else lists only the channels it reads, so no page is
    // shorter and no cursor placed for what it can't read.
    const reads = (channel: { id: string }) => may(actor, 'read', channel.id)
    const readsAll = channels.every(reads)
    /** The channels the list reads: null for the whole board. */
    let within: Set<string> | null = null
    /** A tree a page is narrowed to after it's read, for a caller that reads the whole board. */
    let tree: Set<string> | null = null
    if (query('channelId') !== null) {
      const channel = channels.find((c) => c.id === query('channelId'))
      if (!channel || !reads(channel)) throw new Refused(404, 'channel_not_found')
      within = new Set([channel.id])
    } else if (named !== null && !named.endsWith('/')) {
      const channel = channels.find((c) => c.name === named)
      // A name no channel has lists nothing, and neither does one the caller can't read.
      if (!channel || !reads(channel)) return { tasks: [], cursor: null }
      within = new Set([channel.id])
    } else if (readsAll) {
      tree = named !== null ? new Set(channelsNamed(named).map((channel) => channel.id)) : null
    } else {
      const read = (named !== null ? channelsNamed(named) : channels).filter(reads)
      if (read.length > 50) throw new Refused(400, 'channel_tree_too_large', 'Name a channel, or a smaller tree: this list would read more than 50 channels.')
      within = new Set(read.map((channel) => channel.id))
    }
    // What's ready is stored ready, or claimed with a lease that ran out: both are read, and the live claim decides after.
    const stored = states?.includes('ready') && !states.includes('claimed') ? [...states, 'claimed'] : states
    // The tasks that wait for one are read from under it for a caller that reads the whole board: for anyone else, `needs` is one more filter after each page.
    const needs = query('needs')
    const inOrder = [...threads.values()]
      .filter((t) => t.task && (within === null || within.has(t.channelId)) && (stored === null || stored.includes(t.task.state)) && (!readsAll || needs === null || t.task.needs.includes(needs)))
      .sort(oldestFirst)
    // `after` goes on after a task in creation order, in place of a cursor: a task the caller reads, which needn't be in the list.
    const after = query('after')
    if (after !== null && query('cursor') !== null) throw new Refused(400, 'invalid_request', 'Read on with after or with cursor, not both.')
    const last = after === null ? undefined : threads.get(after)
    if (after !== null && (!last?.task || !may(actor, 'read', last.channelId))) throw new Refused(400, 'invalid_request', 'after names a task you can read.')
    const start = last ? inOrder.filter((t) => t.createdAt <= last.createdAt).length : 0
    const { items, cursor } = page(inOrder, query('cursor') ?? String(start), 25)
    // What it sees that no request wrote yet, best effort: the expiry of a lapsed claim, a completion on its page that
    // hasn't readied everything that waited for it, and for the first waiting tasks on its page, their readying. A
    // list that reads no waiting task readies none of its own.
    let expired = 0
    for (const thread of items) if (expired < REPAIRS && expire(thread)) expired++
    let goneOver = GONE_OVER
    for (const thread of items.filter((t) => t.task?.marked)) goneOver = goOn(thread, goneOver, undefined)
    for (const thread of items.filter((t) => t.task?.state === 'waiting').slice(0, REPAIRS)) ready(thread, actor, undefined)
    const labels = url.searchParams.getAll('label').map((label) => label.split('=', 2) as [string, string | undefined])
    const wears = (t: Thread): Record<string, string> => ({ ...rootLabels(t), 'board.task': live(t.task!) })
    const kept = items.filter(
      (t) =>
        (tree === null || tree.has(t.channelId)) &&
        (states === null || states.includes(live(t.task!))) &&
        labels.every(([key, value]) => Object.hasOwn(wears(t), key) && (value === undefined || wears(t)[key] === value)) &&
        (query('owner') === null || t.task!.owner === query('owner')) &&
        (query('for') === null || t.task!.for === query('for')) &&
        (needs === null || t.task!.needs.includes(needs)),
    )
    return {
      tasks: kept.map((t) => {
        if (include === null) return taskOf(t)
        // Its newest message when it has replies: its first is in every task.
        const latest = t.lastMessage && t.lastMessage.sequence > 1 ? t.messages.find((m) => m.sequence === t.lastMessage!.sequence) : undefined
        return { ...taskOf(t), ...(latest ? { latestMessage: show(latest) } : {}) }
      }),
      cursor,
    }
  }

  async function watchers(method: string, rest: string, actor: Actor, parsed: Record<string, any>, url: URL): Promise<unknown> {
    const owner = principalId(actor.principal)
    const view = (r: Registration) => ({ owner: r.owner, ...(r.path ? { path: r.path, ...(r.branch ? { branch: r.branch } : {}) } : {}), watch: r.watch, ...(r.sync.length ? { sync: r.sync } : {}), hash: r.hash })
    if (method === 'GET' && rest === '/watchers') {
      const found = registrations.get(owner)
      return { watchers: found ? [view(found)] : [] }
    }
    if (method === 'PUT' && rest === '/watchers') {
      const body = parsed as { path?: string; branch?: string; watch: Registration['watch']; tag?: string; sync?: Registration['sync'] }
      // A path on the caller's own project (a preview's with its branch), or none to pull, as api-messageboard checks one.
      // A deployment is woken by its path on its project, or pulls: never at a URL, and the API refuses any `url`, even null.
      if ('url' in parsed) throw new Refused(400, 'invalid_request', 'Watchers are woken by a path, not a url.')
      if (body.branch !== undefined && body.path === undefined) throw new Refused(400, 'invalid_request', 'A branch goes with a path.')
      const principal = actor.principal
      if (body.path !== undefined) {
        if (principal.type !== 'project') throw new Refused(403, 'not_a_project')
        // Any environment's: the API finds what to wake from the caller's token, and a preview's by its branch when it names one.
        if (body.branch !== undefined && principal.environment !== 'preview') throw new Refused(400, 'invalid_branch')
        if (typeof body.path !== 'string' || !body.path.startsWith('/') || body.path.startsWith('//')) throw new Refused(400, 'invalid_path')
      }
      const where = body.path !== undefined ? { path: body.path.replace(/(.)\/+$/, '$1'), ...(body.branch ? { branch: body.branch } : {}) } : {}
      const sync = body.sync ?? []
      // Only a project's own token syncs.
      if (sync.length > 0 && principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      // Watchers are for waking a deployment: only its own credentials register them.
      if (principal.type !== 'project') throw new Refused(403, 'watchers_need_project', 'Only a deployment can register watchers.')
      // A key is one registrant's in its project: production takes it from a preview or development, and otherwise
      // whoever registered it first keeps it, and the rest hear who has it. With `boardWideKeys`, one's on the board, and a second's 409.
      const scope = scopeOf(principal)
      const environmentOf = (holder: string) => holder.split(':')[3]!
      const held: Registration['sync'] = []
      const elsewhere: { key: string; platform: string; owner: string; environment: string }[] = []
      for (const entry of sync) {
        const holder = syncKeys.get(`${scope}|${entry.key}`)
        if (holder === undefined || holder === owner || (!shared.boardWideKeys && principal.environment === 'production' && environmentOf(holder) !== 'production')) held.push(entry)
        else if (shared.boardWideKeys) throw new Refused(409, 'sync_key_taken')
        else elsewhere.push({ key: entry.key, platform: entry.platform, owner: holder, environment: environmentOf(holder) })
      }
      for (const [at, holder] of syncKeys) if (holder === owner && !held.some((entry) => at === `${scope}|${entry.key}`)) syncKeys.delete(at)
      for (const { key } of held) {
        // The deployment production took it from stops syncing it, and is no longer woken for it.
        const before = syncKeys.get(`${scope}|${key}`)
        const taken = before === undefined || before === owner ? undefined : registrations.get(before)
        if (taken) taken.sync = taken.sync.filter((entry) => entry.key !== key)
        syncKeys.set(`${scope}|${key}`, owner)
      }
      const made: Registration = { owner, ...where, watch: body.watch, sync: held, hash: body.tag ?? randomUUID().replaceAll('-', '') }
      registrations.set(owner, made)
      return shared.boardWideKeys ? view(made) : { ...view(made), elsewhere: elsewhere.sort((a, b) => a.key.localeCompare(b.key)) }
    }
    if (!registrations.has(owner)) throw new Refused(404, 'no_registration')
    if (method === 'GET' && rest === '/watchers/matches') {
      const until = Date.now() + Number(url.searchParams.get('wait') ?? 0) * 1000
      const limit = Number(url.searchParams.get('limit') ?? 10)
      for (;;) {
        // Read again each time: a match queued while it waits may be the registrant's first.
        const lane = queued.get(owner) ?? []
        // One leased, or waiting after an error, holds up its watcher's thread.
        const held = new Set(lane.filter((m) => (m.lease && m.leaseUntil! > Date.now()) || (m.retryAt ?? 0) > Date.now()).map((m) => `${m.watcher}|${m.threadId}`))
        const heads = new Map<string, Match>()
        for (const m of lane) if (!heads.has(`${m.watcher}|${m.threadId}`)) heads.set(`${m.watcher}|${m.threadId}`, m)
        const free = [...heads.entries()].filter(([key]) => !held.has(key)).map(([, m]) => m).slice(0, limit)
        if (free.length > 0 || Date.now() >= until) {
          for (const m of free) {
            if (m.lease) m.attempts++
            m.lease = randomUUID()
            m.leaseUntil = Date.now() + 5 * 60_000
          }
          const shown = free.map((m) => {
            const message = messageNamed((m.change as { messageId: string }).messageId)
            return { id: m.id, watcher: m.watcher, threadId: m.threadId, lease: m.lease, attempt: m.attempts, event: { ...m.change, ...(message && shared.matchMessages ? { currentMessage: show(message) } : {}) } }
          })
          return { matches: shown }
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    const lane = queued.get(owner) ?? []
    const acking = /^\/watchers\/matches\/([^/]+)\/ack$/.exec(rest)
    if (method === 'POST' && acking) {
      const body = parsed as { lease: string; error?: string; skip?: boolean }
      const at = lane.findIndex((m) => m.id === decodeURIComponent(acking[1]!))
      if (at === -1) throw new Refused(404, 'no_match')
      if (lane[at]!.lease !== body.lease) throw new Refused(409, 'stale_lease')
      // After an error it waits a second, doubling to 30, as the API's does.
      if (body.error !== undefined && !body.skip) {
        lane[at]!.attempts++
        lane[at]!.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (lane[at]!.attempts - 1))
        delete lane[at]!.lease
      } else lane.splice(at, 1)
      return { ok: true }
    }
    throw new Refused(404, 'not_found')
  }

  const showSchedule = (s: Schedule) => ({ ...s, ...(s.labels ? { labels: { ...s.labels } } : {}) })

  /** Times are whole milliseconds, a year out at most, and a repeat is at least a minute apart, with one stop. */
  function schedule(actor: Actor, body: Record<string, any>): Schedule {
    const invalid = () => new Refused(400, 'invalid_schedule')
    if (actor.principal.type === 'app') throw new Refused(403, 'principal_cannot_schedule')
    if ((body.channelId === undefined) === (body.threadId === undefined)) throw invalid()
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) throw new Refused(400, 'invalid_message', 'A message is 1 to 10000 characters.')
    const at = Date.now()
    const time = (value: unknown) => Number.isInteger(value) && (value as number) > 0 && (value as number) <= at + 365 * 86_400_000
    if (!time(body.firstAt) || body.firstAt < at - 60_000) throw invalid()
    if (body.every !== undefined && (!Number.isInteger(body.every) || body.every < 60_000)) throw invalid()
    if (body.until !== undefined && !time(body.until)) throw invalid()
    if (body.times !== undefined && (!Number.isInteger(body.times) || body.times < 1)) throw invalid()
    const stops = [body.until, body.times].filter((stop) => stop !== undefined).length
    if (stops > 1 || (stops > 0 && body.every === undefined)) throw invalid()
    const channelId = body.threadId !== undefined ? threadAt(body.threadId).channelId : channelAt(body.channelId).id
    const made: Schedule = {
      id: `sch_${randomUUID()}`,
      channelId,
      ...(body.threadId !== undefined ? { threadId: body.threadId } : {}),
      text: body.text,
      ...(body.labels ? { labels: { ...body.labels } } : {}),
      ...(body.noSync ? { noSync: true } : {}),
      firstAt: body.firstAt,
      ...(body.every !== undefined ? { every: body.every } : {}),
      ...(body.until !== undefined ? { until: body.until } : {}),
      ...(body.times !== undefined ? { times: body.times } : {}),
      sent: 0,
      nextAt: Math.max(body.firstAt, at),
      state: 'pending',
      createdAt: now(),
      createdBy: actor,
      revision: 1,
    }
    schedules.set(made.id, made)
    seen(actor)
    return made
  }

  /** A schedule's next send, as the API posts it when it's due: as its creator, marked as the schedule's. */
  function send(id: string) {
    const due = schedules.get(id)
    if (!due || due.state !== 'pending') throw new Error(`schedule ${id} has nothing due`)
    const n = due.sent
    const body = { text: due.text, schedule: { id, n }, ...(due.noSync ? { noSync: true } : {}) }
    let message: Message
    if (due.threadId !== undefined) message = post(due.createdBy, threadAt(due.threadId), body)
    else {
      const createdAt = now()
      const thread: Thread = { id: `thr_${randomUUID()}`, channelId: due.channelId, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: due.createdBy, messages: [] }
      threads.set(thread.id, thread)
      message = post(due.createdBy, thread, { ...body, ...(due.labels ? { labels: due.labels } : {}) })
    }
    due.sent = n + 1
    due.lastMessageId = message.id
    due.revision++
    const next = due.every === undefined ? null : due.firstAt + due.every * due.sent
    const over = next === null || (due.times !== undefined && due.sent >= due.times) || (due.until !== undefined && next > due.until)
    due.nextAt = over ? null : next
    if (over) due.state = 'done'
    return message.id
  }

  function schedulesRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/schedules') return { schedule: showSchedule(schedule(actor, body)) }
    if (method === 'GET' && rest === '/schedules') {
      const query = (name: string) => url.searchParams.get(name) ?? undefined
      // By its ID, a channel that isn't there lists nothing; by its name, it's a 404.
      const named = query('channel') === undefined ? undefined : channelRead(url, actor)!.id
      const state = query('state')
      const createdBy = query('createdBy')
      const listed = [...schedules.values()].sort((a, b) => a.createdAt - b.createdAt)
      const matches = (s: Schedule) =>
        (state === undefined || s.state === state) &&
        (query('channelId') === undefined || s.channelId === query('channelId')) &&
        (named === undefined || s.channelId === named) &&
        (query('threadId') === undefined || s.threadId === query('threadId')) &&
        (createdBy === undefined || s.createdBy.id === createdBy || principalId(s.createdBy.principal) === createdBy)
      // It reads on past the schedules a filter leaves out until its page is full, up to a bound, so a page can still come back short with a cursor to the rest.
      let at = Number(url.searchParams.get('cursor') ?? 0)
      const bound = Math.min(listed.length, at + 6)
      const kept: Schedule[] = []
      for (; at < bound && kept.length < 2; at++) if (matches(listed[at]!)) kept.push(listed[at]!)
      return { schedules: kept.map(showSchedule), cursor: at < listed.length ? String(at) : null }
    }
    if ((found = /^\/schedules\/([^/]+)\/cancel$/.exec(rest)) && method === 'POST') {
      const target = schedules.get(decodeURIComponent(found[1]!))
      if (!target) throw new Refused(404, 'schedule_not_found')
      if (!owns(actor, target.createdBy)) throw new Refused(403, 'schedule_not_owned')
      if (target.state !== 'pending') return { schedule: showSchedule(target), canceled: false }
      Object.assign(target, { state: 'canceled', nextAt: null, canceled: { by: actor, at: now(), reason: 'canceled' }, revision: target.revision + 1 })
      return { schedule: showSchedule(target), canceled: true }
    }
    return undefined
  }


  const prefixOf = (id: string) => id.slice(0, id.indexOf(':'))
  /** Only a project's own token syncs, through the keys it holds. */
  function requireKey(actor: Actor, key: string) {
    if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
    if (syncKeys.get(`${scopeOf(actor.principal)}|${key}`) !== principalId(actor.principal)) throw new Refused(403, 'sync_key_not_owned')
  }
  /** The platform the caller registered a sync key with. */
  const platformOf = (owner: string, key: string) => registrations.get(owner)?.sync.find((entry) => entry.key === key)?.platform ?? key
  const ownedKeys = (actor: Actor) =>
    new Set([...syncKeys].filter(([, owner]) => owner === principalId(actor.principal)).map(([at]) => at.slice(at.indexOf('|') + 1)))

  /** Vercel's API's sync routes, as they behave: undefined for a route that isn't one. */
  function syncRoute(method: string, rest: string, actor: Actor, body: Record<string, any>, url: URL): unknown {
    const owner = principalId(actor.principal)
    const scope = scopeOf(actor.principal)
    let found: RegExpExecArray | null
    if (method === 'POST' && rest === '/sync/imports') {
      // The key it came through, or for a write a sync makes as the user, the user's own.
      const key: string = body.from ?? prefixOf(body.author.id)
      requireKey(actor, key)
      if (!String(body.author.id).startsWith(`${key}:`)) throw new Refused(403, 'foreign_author')
      if (body.origin && !body.from) throw new Refused(400, 'invalid_import', 'An import with an origin names the sync key it came through: pass `from`.')
      // A change it imported says which sync it came through, so that sync doesn't send it back.
      const through = body.from ? { from: body.from } : {}
      // The platform user is a profile of the project whose sync speaks for them, under the key it came through.
      const principal = actor.principal as Extract<Principal, { type: 'project' }>
      const author: Actor = shared.externalImports
        ? { id: body.author.id, principal: { type: 'external', id: body.author.id, syncKey: key } }
        : { id: `${owner}+${body.author.id}`, principal, profile: { name: body.author.id, platform: { key, platform: platformOf(owner, key), userId: String(body.author.id).slice(key.length + 1) } } }
      const via = shared.externalImports ? {} : { via: { name: shared.directory.projects[principal.projectId] ?? null, environment: principal.environment }, platform: platformOf(owner, key) }
      const handle = shared.externalImports || shared.platformHandles ? body.author.handle : importedHandle(shared.directory.projects[principal.projectId] ?? principal.projectId, body.author.handle, userIdOf(body.author.id))
      actors.set(author.id, { id: author.id, kind: 'external', handle, name: body.author.name, ...(body.author.avatar ? { avatar: body.author.avatar } : {}), ...via, lastSeenAt: now() })
      // The platform users a post's or an edit's text mentions, by the actor each is: one the board hasn't met is
      // recorded as the author is, one it knows keeps its row, and one the text doesn't mention is left out.
      if ((body.op === 'post' || body.op === 'edit') && body.mentioned !== undefined) {
        if (!Array.isArray(body.mentioned) || body.mentioned.length > 50) throw new Refused(400, 'invalid_import')
        for (const user of body.mentioned as { id: string; handle: string; name: string; avatar: string | null }[]) {
          if (!String(user.id).startsWith(`${key}:`)) throw new Refused(403, 'foreign_author')
          const id = shared.externalImports ? user.id : `${owner}+${user.id}`
          if (!String(body.text).includes(`@[${id}]`) || actors.has(id)) continue
          const named = shared.externalImports || shared.platformHandles ? user.handle : importedHandle(shared.directory.projects[principal.projectId] ?? principal.projectId, user.handle, userIdOf(user.id))
          actors.set(id, { id, kind: 'external', handle: named, name: user.name, ...(user.avatar ? { avatar: user.avatar } : {}), ...via, lastSeenAt: now() })
        }
      }
      if (body.op === 'post') {
        const landed = body.id !== undefined ? importIds.get(`${owner}|${body.id}`) : undefined
        if (landed) return { message: landed }
        const origin = body.origin as { thread: string; message: string } | null | undefined
        if (origin && body.channelId !== undefined && platformThreads.has(`${scope}|${key}|${origin.thread}`)) throw new Refused(409, 'already_synced')
        let thread: Thread
        if (body.channelId !== undefined) {
          const channel = channelAt(body.channelId)
          const createdAt = now()
          thread = { id: `thr_${randomUUID()}`, channelId: channel.id, messageCount: 0, lastActivityAt: createdAt, createdAt, createdBy: author, messages: [] }
          threads.set(thread.id, thread)
        } else if (body.re !== undefined) {
          const to = messageNamed(body.re)
          if (!to) throw new Refused(404, 'message_not_found')
          thread = threadAt(to.threadId)
          // A platform reply lands only in the thread its platform thread syncs with.
          const bound = origin ? platformThreads.get(`${scope}|${key}|${origin.thread}`) : undefined
          if (origin && bound !== undefined && bound !== thread.id) throw new Refused(409, 'already_synced')
          if (origin && bound === undefined) throw new Refused(409, 'not_synced')
        } else throw new Refused(400, 'invalid_import')
        const message = post(author, thread, { text: body.text, ...(body.labels ? { labels: body.labels } : {}), ...(body.attachments?.length ? { attachments: body.attachments } : {}), ...(body.after !== undefined ? { after: body.after } : {}) }, actor)
        if (body.from !== undefined && body.from !== null) message.from = body.from
        if (origin) message.origin = origin
        if (body.noSync) message.noSync = true
        if (body.links?.length) message.links = body.links
        if (origin) {
          // A platform root binds its thread to its platform thread, which announces nothing.
          if (body.channelId !== undefined) {
            platformThreads.set(`${scope}|${key}|${origin.thread}`, thread.id)
            bindings.set(thread.id, [{ target: origin.thread, targetKind: 'thread', cause: 'import', external: origin.thread, ...projectOf(actor.principal) }])
          }
          platformMessages.set(`${scope}|${key}|${origin.thread}|${origin.message}`, message.id)
        }
        if (body.id !== undefined) importIds.set(`${owner}|${body.id}`, message.id)
        return { message: message.id }
      }
      const origin = body.origin as { thread: string; message?: string } | undefined
      const id = origin
        ? origin.message !== undefined
          ? platformMessages.get(`${scope}|${key}|${origin.thread}|${origin.message}`)
          : platformThreads.has(`${scope}|${key}|${origin.thread}`) ? `msg_${platformThreads.get(`${scope}|${key}|${origin.thread}`)!.slice('thr_'.length)}_1` : undefined
        : body.message
      const message = id ? messageNamed(id) : undefined
      if (!message) return { message: null }
      const by = message.createdBy
      // A sync edits and deletes only its own platform users' messages; it reacts and labels on any.
      if (body.op === 'edit' || body.op === 'delete') {
        const own = by.principal.type === 'external' ? by.principal.syncKey === key : by.profile?.platform?.key === key && samePrincipal(by.principal, actor.principal)
        if (!own || (body.message !== undefined && by.id !== author.id)) {
          throw new Refused(403, 'message_not_owned')
        }
        if (body.revision !== undefined && body.revision !== message.revision) {
          throw new Refused(409, 'revision_conflict')
        }
      }
      const thread = threadAt(message.threadId)
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      if (body.op === 'edit') {
        message.text = body.text
        message.revision++
        message.editedAt = now()
        message.changes++
        emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision, ...through }, author)
        if (message.sequence === 1) rootEdited(thread, author)
      } else if (body.op === 'delete') {
        message.deletedAt = now()
        message.revision++
        message.changes++
        emit(thread.channelId, { type: 'message.deleted', ...ref, revision: message.revision, ...through }, author)
        if (message.sequence === 1) rootDeleted(thread, author)
      } else if (body.op === 'react') {
        const reactors = message.reactions.get(body.emoji) ?? new Map()
        if (body.remove) {
          reactors.delete(author.id)
        } else {
          reactors.set(author.id, { actor: author, createdAt: now() })
        }
        if (reactors.size) {
          message.reactions.set(body.emoji, reactors)
        } else {
          message.reactions.delete(body.emoji)
        }
        message.changes++
        emit(thread.channelId, { type: body.remove ? 'message.reaction_removed' : 'message.reaction_added', ...ref, emoji: body.emoji, ...through }, author)
      } else if (body.op === 'labels') {
        for (const [label, value] of Object.entries(body.if ?? {})) if ((message.labels[label] ?? null) !== value) throw new Refused(409, 'label_conflict')
        const before = { ...message.labels }
        for (const label of body.unset ?? []) delete message.labels[label]
        Object.assign(message.labels, body.set ?? {})
        message.changes++
        const changed = Object.fromEntries(
          [...new Set([...Object.keys(before), ...Object.keys(message.labels)])]
            .filter((label) => before[label] !== message.labels[label])
            .map((label) => [label, { ...(before[label] !== undefined ? { from: before[label] } : {}), ...(message.labels[label] !== undefined ? { to: message.labels[label] } : {}) }]),
        )
        if (Object.keys(changed).length) emit(thread.channelId, { type: 'message.labeled', ...ref, labels: changed, ...through }, author)
      } else if (body.op === 'links') {
        // The API keeps a message's links as an edit of it.
        message.links = body.links
        message.changes++
        emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision, ...through }, author)
      }
      return { message: message.id }
    }
    if (method === 'POST' && rest === '/sync/receipts') {
      const message = messageNamed(body.message)
      if (!message) throw new Refused(404, 'message_not_found')
      const key = prefixOf(body.target)
      requireKey(actor, key)
      const project = projectOf(actor.principal)
      const at = `${scope}|${body.target}`
      if (body.kind === 'thread') {
        const list = bindings.get(message.threadId) ?? []
        bindings.set(message.threadId, list)
        if (list.some((bound) => bound.target === body.target && bound.projectId === project.projectId)) return { ok: true, attached: false }
        if (body.targetKind === 'thread') {
          const bound = platformThreads.get(`${scope}|${key}|${body.target}`)
          if (bound && bound !== message.threadId) throw new Refused(409, 'already_synced')
          platformThreads.set(`${scope}|${key}|${body.target}`, message.threadId)
        }
        const binding = { target: body.target, targetKind: body.targetKind, cause: body.cause, ...project }
        list.push({ ...binding, ...(body.targetKind === 'thread' ? { external: body.target } : {}) })
        const thread = threadAt(message.threadId)
        emit(thread.channelId, { type: 'thread.synced', threadId: thread.id, messageId: thread.messages[0]!.id, binding }, actor)
        return { ok: true, attached: true }
      }
      const mine = copies.get(message.id) ?? {}
      copies.set(message.id, mine)
      if (body.kind === 'message') {
        mine[at] ??= { thread: body.external.thread, message: body.external.message, ...(body.external.asUser ? { asUser: true as const } : {}), ...(body.files !== undefined ? { files: body.files } : {}) }
        // A channel's platform thread is the one its root landed in.
        const bound = message.sequence === 1 ? bindings.get(message.threadId)?.find((one) => one.target === body.target && one.targetKind === 'channel' && one.projectId === project.projectId) : undefined
        if (bound && bound.external === undefined) {
          bound.external = body.external.thread
          platformThreads.set(`${scope}|${key}|${body.external.thread}`, message.threadId)
        }
        platformMessages.set(`${scope}|${key}|${body.external.thread}|${body.external.message}`, message.id)
        delete failures.get(message.id)?.[at]
      } else if (body.kind === 'files') {
        if (mine[at]) mine[at]!.files = body.files
      } else {
        const failed = failures.get(message.id) ?? {}
        failures.set(message.id, failed)
        failed[at] = body.error
      }
      return { ok: true }
    }
    if (method === 'GET' && rest === '/sync/find') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const owned = ownedKeys(actor)
      const query = Object.fromEntries(url.searchParams)
      let thread: string | null = null
      let message: string | null = null
      if (query.post !== undefined) message = importIds.get(`${owner}|${query.post}`) ?? null
      if (query.thread !== undefined && owned.has(prefixOf(query.thread))) {
        thread = platformThreads.get(`${scope}|${prefixOf(query.thread)}|${query.thread}`) ?? null
        if (query.message !== undefined) message = platformMessages.get(`${scope}|${prefixOf(query.thread)}|${query.thread}|${query.message}`) ?? message
      }
      // The API links no platform accounts to people, so it finds none.
      return { thread, message, person: null, accounts: [], holder: null }
    }
    if ((found = /^\/sync\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const thread = threadAt(decodeURIComponent(found[1]!))
      const owned = ownedKeys(actor)
      // Its own project's targets, through the keys it holds: with `unscopedSync`, every one.
      const mine = (bindings.get(thread.id) ?? []).filter((bound) => shared.unscopedSync || (owned.has(prefixOf(bound.target)) && (bound.projectId ?? '') === scope))
      return {
        thread: thread.id,
        root: thread.messages[0]!.id,
        channel: thread.channelId,
        targets: mine.map((bound) => bound.target),
        external: Object.fromEntries(mine.flatMap((bound) => (bound.external !== undefined ? [[bound.target, bound.external]] : []))),
      }
    }
    if (method === 'GET' && rest === '/sync/copies') {
      if (actor.principal.type !== 'project') throw new Refused(403, 'sync_needs_project')
      const owned = ownedKeys(actor)
      const own = (id: string) =>
        Object.entries(copies.get(id) ?? {}).flatMap(([at, copy]) => {
          const target = at.slice(at.indexOf('|') + 1)
          return at.startsWith(`${scope}|`) && owned.has(prefixOf(target)) ? [[target, copy] as const] : []
        })
      return { copies: Object.fromEntries(url.searchParams.getAll('message').map((id) => [id, Object.fromEntries(own(id))])) }
    }
    if ((found = /^\/messages\/([^/]+)\/synced$/.exec(rest)) && method === 'GET') {
      const message = messageNamed(decodeURIComponent(found[1]!))
      if (!message) throw new Refused(404, 'message_not_found')
      const mine = copies.get(message.id) ?? {}
      const failed = failures.get(message.id) ?? {}
      return {
        // Every project's targets, each saying whose it is.
        targets: (bindings.get(message.threadId) ?? []).map(({ target, projectId }) => ({
          target,
          key: prefixOf(target),
          thread: mine[`${projectId ?? ''}|${target}`]?.thread ?? null,
          message: mine[`${projectId ?? ''}|${target}`]?.message ?? null,
          undelivered: failed[`${projectId ?? ''}|${target}`] ?? null,
          ...(projectId !== undefined ? { projectId } : {}),
        })),
      }
    }
    if (method === 'GET' && rest === '/sync/linked') {
      const thread = url.searchParams.get('thread') ?? ''
      const named = url.searchParams.get('message')
      // Every project's that holds the key, the caller's own first.
      const scopes = new Set([scope, ...[...platformThreads.keys()].map((at) => at.slice(0, at.indexOf('|')))])
      const idIn = (where: string) => {
        const at = `${where}|${prefixOf(thread)}|${thread}`
        return named !== null ? platformMessages.get(`${at}|${named}`) : platformThreads.has(at) ? `msg_${platformThreads.get(at)!.slice('thr_'.length)}_1` : undefined
      }
      const id = [...scopes].map(idIn).find((one) => one !== undefined)
      const message = id ? messageNamed(id) : undefined
      if (!message) throw new Refused(404, 'message_not_found')
      return { thread: message.threadId, message: message.id }
    }
    if ((found = /^\/sync\/inbox\/([^/]+)(\/next|\/([^/]+)\/ack)?$/.exec(rest))) {
      const key = decodeURIComponent(found[1]!)
      requireKey(actor, key)
      const inbox = inboxes.get(`${scope}|${key}`) ?? []
      inboxes.set(`${scope}|${key}`, inbox)
      if (method === 'POST' && found[2] === undefined) {
        let queued = 0
        for (const event of body.events as { id: string; thread: string; event?: unknown; raw?: unknown }[]) {
          if (!event.thread.startsWith(`${key}:`)) throw new Refused(400, 'invalid_inbox_event')
          if (inbox.some((entry) => entry.eventId === event.id)) continue
          inbox.push({ id: `inb_${randomUUID()}`, eventId: event.id, thread: event.thread, event: event.event, raw: event.raw, pushedAt: now(), attempts: 0 })
          queued++
        }
        return { ok: true, queued }
      }
      if (method === 'GET' && found[2] === '/next') {
        const limit = Number(url.searchParams.get('limit') ?? 10)
        const items: unknown[] = []
        for (const thread of new Set(inbox.filter((entry) => !entry.done).map((entry) => entry.thread))) {
          if (items.length >= limit) break
          const head = inbox.find((entry) => !entry.done && entry.thread === thread)!
          if ((head.lease && head.leaseUntil! > Date.now()) || (head.retryAt ?? 0) > Date.now()) continue
          if (head.lease) head.attempts++
          head.lease = randomUUID()
          head.leaseUntil = Date.now() + 5 * 60_000
          items.push({ id: head.id, key, thread: head.thread, lease: head.lease, attempt: head.attempts, ...(head.event !== undefined ? { event: head.event } : {}), ...(head.raw !== undefined ? { raw: head.raw } : {}) })
        }
        return { items }
      }
      if (method === 'POST' && found[3] !== undefined) {
        const entry = inbox.find((one) => one.id === decodeURIComponent(found![3]!) && !one.done)
        if (!entry) throw new Refused(404, 'no_item')
        if (entry.lease !== body.lease) throw new Refused(409, 'stale_lease')
        // After an error it waits a second, doubling to 30, and the fifth is its last try.
        if (body.error !== undefined && entry.attempts + 1 < 5) {
          entry.attempts++
          entry.retryAt = Date.now() + Math.min(30_000, 1000 * 2 ** (entry.attempts - 1))
          delete entry.lease
          delete entry.leaseUntil
        } else entry.done = true
        return { ok: true }
      }
      if (method === 'GET' && found[2] === undefined) {
        const limit = Number(url.searchParams.get('limit') ?? 50)
        return { events: [...inbox].reverse().slice(0, limit).map((entry) => ({ id: entry.eventId, thread: entry.thread, pushedAt: entry.pushedAt, ...(entry.event !== undefined ? { event: entry.event } : {}), ...(entry.raw !== undefined ? { raw: entry.raw } : {}) })) }
      }
    }
    return undefined
  }

  /** The reads that answer the actors they name with `with=actors`: threads, messages, and a channel's changes. */
  const NAMING = /^\/(threads|messages|changes|messages\/[^/]+|threads\/[^/]+\/messages)$/
  /** Everyone a read's answer names: who started each thread and wrote its messages, and who each change is by. */
  const namedIn = (read: { threads?: any[]; thread?: any; messages?: any[]; message?: any; events?: any[] }): Actor[] => [
    ...(read.threads ?? (read.thread ? [read.thread] : [])).flatMap((t) => [t.createdBy, ...[t.lastMessage, t.rootMessage, t.latestMessage].flatMap((m) => (m ? [m.createdBy] : []))]),
    ...(read.messages ?? (read.message ? [read.message] : [])).map((m) => m.createdBy),
    ...(read.events ?? []).flatMap((change) => [change.actor, ...(change.currentMessage ? [change.currentMessage.createdBy] : [])]),
  ]
  /** A request to this board, at `rest` under `/boards/:id`, from a caller who may use it. */
  async function route(method: string, rest: string, url: URL, body: Record<string, any>, actor: Actor, signal?: AbortSignal, version: 1 | 2 = 1): Promise<unknown> {
    let found: RegExpExecArray | null

    if (url.searchParams.has('with')) {
      // An API from before `with=actors` takes no `with`, as no route that names nobody does, and no other parameter it doesn't know.
      if (!shared.inlineActors || method !== 'GET' || version !== 1 || !NAMING.test(rest)) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `with`.')
      if (url.searchParams.get('with') !== 'actors') throw new Refused(400, 'invalid_request')
      const plain = new URL(url)
      plain.searchParams.delete('with')
      const read = (await route(method, rest, plain, body, actor, signal, version)) as Record<string, unknown>
      // Each one once, as the actors route answers them by ID: one it has no view of is left out.
      return { ...read, actors: [...new Set(namedIn(read).map(({ id }) => id))].flatMap((id) => actors.get(id) ?? []) }
    }

    if (method === 'GET' && rest === '/channels') {
      const name = url.searchParams.get('name')
      // It lists only the channels the caller may read.
      const readable = channels.filter((c) => mayRead(actor, c.id))
      const prefix = url.searchParams.get('prefix')
      const limit = url.searchParams.get('limit')
      if (prefix === null && limit === null) return { channels: name === null ? readable : readable.filter((c) => c.name === name), cursor: null }
      // An API from before pages and prefixes takes neither parameter, as it takes no other it doesn't know.
      if (!shared.channelPages) throw new Refused(400, 'invalid_request', `Invalid request: should NOT have additional property \`${prefix !== null ? 'prefix' : 'limit'}\`.`)
      if (name !== null) throw new Refused(400, 'invalid_request', 'Look a channel up by name or page through channels, not both.')
      const size = Number(limit ?? 50)
      if (!Number.isInteger(size) || size < 1 || size > 100) throw new Refused(400, 'invalid_request', 'A page holds 1 to 100 channels.')
      // Under a prefix, by name with `/` before any other character: a channel right before the ones under it.
      const byName = (c: { name: string }) => c.name.replaceAll('/', '\u0000')
      const listed = prefix === null ? readable : readable.filter((c) => c.name.startsWith(prefix)).sort((a, b) => (byName(a) < byName(b) ? -1 : 1))
      // A cursor reads on only the list that answered it: the one of its prefix, or the one with none.
      const scope = prefix === null ? 'all' : createHash('sha256').update(prefix).digest('hex').slice(0, 8)
      const cursor = url.searchParams.get('cursor')
      const found = cursor === null ? null : /^(\w+)\.(\d+)$/.exec(cursor)
      if (cursor !== null && found?.[1] !== scope) throw new Refused(400, 'invalid_cursor')
      const from = found ? Number(found[2]) : 0
      return { channels: listed.slice(from, from + size), cursor: from + size < listed.length ? `${scope}.${from + size}` : null }
    }
    if (method === 'GET' && (found = /^\/channels\/([^/]+)$/.exec(rest))) {
      // One channel by its ID, to a caller who may read it: to anyone else it isn't there.
      const channel = channelAt(decodeURIComponent(found[1]!))
      if (!mayRead(actor, channel.id)) throw new Refused(404, 'channel_not_found')
      return { channel }
    }
    if (method === 'POST' && rest === '/channels') {
      tokenMayIn(actor, 'read', typeof body.name === 'string' ? body.name : '')
      return { channel: makeChannel(body.name) }
    }
    const granted = access.route(method, rest, whoOf(actor), actor.id, body, url)
    if (granted !== undefined) return granted
    // Version 2 has the task routes and nothing else; version 1 has everything else and none of them.
    if (version === 2) {
      const task = shared.tasks ? await taskRoute(method, rest, url, body, actor, signal) : undefined
      if (task !== undefined) return task
      throw new Refused(404, 'not_found', `${method} /v2${rest}`)
    }
    if (method === 'GET' && rest === '/threads') {
      // A channel's threads: it takes nothing of tasks, and refuses what it doesn't know.
      const read = url.searchParams.has('task') ? null : channelRead(url, actor)
      if (!read) throw new Refused(400, 'invalid_request', 'List a channel\'s threads: channelId, and no task.')
      const channelId = read.id
      const label = url.searchParams.get('label')
      let listed = [...threads.values()].filter((t) => t.channelId === channelId)
      if (label !== null) {
        const [key, value] = label.split('=', 2) as [string, string | undefined]
        // By a first message's labels: `board.task` is one of a task's, by its live claim, so a lease that ran out reads ready here.
        const wears = (t: Thread): Record<string, string> => ({ ...rootLabels(t), ...(t.task ? { 'board.task': live(t.task) } : {}) })
        listed = listed.filter((t) => Object.hasOwn(wears(t), key) && (value === undefined || wears(t)[key] === value))
        listed.sort((a, b) => a.createdAt - b.createdAt)
      } else listed.sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      // A cursor as the API makes one: base64url JSON whose scope names the channel's thread list.
      const scope = `${teamId}#${boardId}#${channelId}#threads`
      const sent = url.searchParams.get('cursor')
      let from: string | null = null
      if (sent !== null) {
        const read = (() => {
          try {
            return JSON.parse(Buffer.from(sent, 'base64url').toString()) as { scope?: unknown; value?: unknown }
          } catch {
            return null
          }
        })()
        if (read?.scope !== scope || typeof read.value !== 'string' || !/^\d+$/.test(read.value)) throw new Refused(400, 'invalid_cursor', 'Invalid cursor.')
        from = read.value
      }
      // 25 a page, or `limit`, 1 to 100: an API from before it takes no `limit`, as it takes no other parameter it doesn't know.
      const asked = url.searchParams.get('limit')
      if (asked !== null && !shared.threadsLimit) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `limit`.')
      const size = asked === null ? 25 : Number(asked)
      if (!/^\d+$/.test(asked ?? '25') || size < 1 || size > 100) throw new Refused(400, 'invalid_request', 'A page holds 1 to 100 threads.')
      const { items, cursor: next } = page(listed, from, size)
      const cursor = next === null ? null : Buffer.from(JSON.stringify({ scope, value: next })).toString('base64url')
      const include = url.searchParams.get('include')
      // An API from before `include=messages` takes no `include`, as it takes no other parameter it doesn't know.
      if (include !== null && !shared.inlineThreadMessages) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `include`.')
      if (include !== null && include !== 'messages') throw new Refused(400, 'invalid_request')
      return {
        threads: items.map((t) => {
          if (include === null) return showThread(t)
          // Each thread's first message, and its newest when it has replies.
          const latest = t.lastMessage && t.lastMessage.sequence > 1 ? t.messages.find((m) => m.sequence === t.lastMessage!.sequence) : undefined
          return { ...showThread(t), ...(t.messages[0] ? { rootMessage: show(t.messages[0]) } : {}), ...(latest ? { latestMessage: show(latest) } : {}) }
        }),
        cursor,
      }
    }
    if (method === 'POST' && rest === '/threads') {
      // A post is a post: what starts a thread as a task is the task routes' to take.
      if (body.task !== undefined) throw new Refused(400, 'invalid_request', 'A post takes no task.')
      const again = repeat(actor, body.clientId)
      if (again) return again
      return once(actor, body.operationId, () => {
        const { thread, message } = startThread(actor, body, () => null, () => {})
        return { thread: showThread(thread), message: show(message) }
      })
    }
    if ((found = /^\/messages\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const id = /^msg_([0-9a-f-]{36})_([1-9]\d*)$/.exec(decodeURIComponent(found[1]!))
      if (!id) throw new Refused(404, 'message_not_found')
      const thread = threads.get(`thr_${id[1]}`)
      const message = thread?.messages[Number(id[2]) - 1]
      if (!thread || !message) throw new Refused(404, 'message_not_found')
      return { thread: showThread(thread), message: show(message), ...withChannel(url, actor, thread.channelId) }
    }
    if ((found = /^\/posts\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const again = repeat(actor, decodeURIComponent(found[1]!))
      if (!again) throw new Refused(404, 'post_not_found')
      return again
    }
    if (rest === '/watchers' || rest.startsWith('/watchers/')) return watchers(method, rest, actor, body, url)
    if (rest.startsWith('/sync/') || /^\/messages\/[^/]+\/synced$/.test(rest)) {
      const answered = syncRoute(method, rest, actor, body, url)
      if (answered !== undefined) return answered
    }
    if (rest === '/schedules' || rest.startsWith('/schedules/')) {
      const answered = schedulesRoute(method, rest, actor, body, url)
      if (answered !== undefined) return answered
    }
    if (method === 'POST' && rest === '/attachments') {
      const attachment: Attachment = { id: `att_${randomUUID()}`, boardId, name: body.name, type: body.type, size: body.size, sha256: body.sha256, state: 'pending', createdAt: now(), createdBy: actor }
      attachments.set(attachment.id, attachment)
      return { attachment, upload: { url: `${STORAGE}${attachment.id}`, method: 'PUT', headers: { 'content-type': body.type, 'x-amz-checksum-sha256': body.sha256 }, expiresAt: now() + 600_000 } }
    }
    if ((found = /^\/attachments\/([^/]+)(\/complete)?$/.exec(rest))) {
      const attachment = attachments.get(decodeURIComponent(found[1]!))
      const own = attachment && samePrincipal(attachment.createdBy.principal, actor.principal)
      if (method === 'POST' && found[2]) {
        if (!attachment || !own) throw new Refused(404, 'attachment_not_found')
        const bytes = stored.get(attachment.id)
        if (!bytes) throw new Refused(409, 'attachment_not_uploaded')
        if (bytes.byteLength !== attachment.size) throw new Refused(422, 'attachment_mismatch')
        attachment.state = 'ready'
        return { attachment }
      }
      if (method === 'GET' && !found[2]) {
        const posted = attachment?.messageId ? MESSAGE_ID.exec(attachment.messageId) : null
        const message = posted ? threads.get(`thr_${posted[1]}`)?.messages[Number(posted[2]) - 1] : undefined
        if (!attachment || attachment.state !== 'ready' || !(own || (message && message.deletedAt === undefined))) throw new Refused(404, 'attachment_not_found')
        return { attachment, url: `${STORAGE}${attachment.id}`, expiresAt: now() + 60_000 }
      }
    }
    if (method === 'GET' && rest === '/actors') {
      if (actor.narrowed && !shared.namesNarrowed) throw new Refused(403, 'forbidden', "You can't read this board.")
      const ids = url.searchParams.getAll('id')
      if (ids.length === 0) return { actors: [...actors.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt), cursor: null }
      // An API from before actors by ID takes no `id`, as it takes no other parameter it doesn't know.
      if (!shared.actorsById) throw new Refused(400, 'invalid_request', 'Invalid request: should NOT have additional property `id`.')
      if (ids.length > 100 || new Set(ids).size !== ids.length || url.searchParams.has('cursor')) throw new Refused(400, 'invalid_request')
      return { actors: ids.flatMap((id) => actors.get(id) ?? []), cursor: null }
    }
    if (method === 'GET' && rest === '/messages') {
      const channelId = (channelRead(url, actor) ?? channelAt('')).id
      const limit = Number(url.searchParams.get('limit') ?? 50)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Refused(400, 'invalid_request')
      const head = feeds.get(channelId)?.length ?? 0
      const listed = [...threads.values()].filter((t) => t.channelId === channelId).flatMap((t) => t.messages).sort((a, b) => a.feedSequence - b.feedSequence)
      // `after` is the old name of `cursor`, which it still takes.
      if (url.searchParams.has('after') && url.searchParams.has('cursor')) throw new Refused(400, 'invalid_request', 'Read on with after or with cursor, not both.')
      const after = url.searchParams.get('cursor') ?? url.searchParams.get('after')
      if (after === null) return { messages: listed.slice(-limit).map(show), cursor: cursorAt(channelId, head), caughtUp: true }
      const from = positionOf(channelId, after)
      const taken = listed.filter((m) => m.feedSequence > from).slice(0, limit)
      const more = listed.filter((m) => m.feedSequence > from).length > limit
      return { messages: taken.map(show), cursor: cursorAt(channelId, more ? taken.at(-1)!.feedSequence : head), caughtUp: !more }
    }
    if (method === 'GET' && rest === '/changes') {
      const named = url.searchParams.get('channel')
      const last = lastOf(url)
      if (url.searchParams.get('channelId') === null && (named === null || named.endsWith('/'))) {
        if (shared.boardFeed) return boardChanges(url, actor, named, last)
        // An API from before the board's feed reads one channel's changes, and takes none without it.
        if (named === null) throw new Refused(400, 'invalid_request', 'Invalid request: missing required property `channelId`.')
      }
      const channelId = (channelRead(url, actor) ?? channelAt('')).id
      shared.feedReads++
      const feed = () => feeds.get(channelId) ?? []
      if (last !== null) {
        const start = Math.max(0, feed().length - last)
        return { events: feed().slice(start).map((change, i) => changeShown(url, change, cursorAt(channelId, start + i + 1))), cursor: cursorAt(channelId, feed().length), caughtUp: true }
      }
      const cursor = url.searchParams.get('cursor')
      if (cursor !== null && url.searchParams.get('from') !== null) throw new Refused(400, 'invalid_cursor')
      const from = url.searchParams.get('from') === 'latest' ? feed().length : cursor === null ? 0 : positionOf(channelId, cursor)
      // A long-poll holds until the next change, as the API's does.
      const until = Date.now() + Math.min(Number(url.searchParams.get('wait') ?? 0), 25) * 1000
      while (feed().length === from && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10))
      const include = url.searchParams.get('include') === 'message'
      const events = feed()
        .slice(from, from + 48)
        .map((change, i) => {
          const message = include && change.messageId ? messageNamed(change.messageId) : undefined
          return { ...change, channel: channelNameOf(change), cursor: cursorAt(channelId, from + i + 1), ...(message ? { currentMessage: show(message) } : {}) }
        })
      return { events, cursor: cursorAt(channelId, from + events.length), caughtUp: from + events.length >= feed().length }
    }
    if ((found = /^\/threads\/([^/]+)$/.exec(rest)) && method === 'GET') {
      const thread = threadAt(found[1]!)
      return { thread: showThread(thread), ...withChannel(url, actor, thread.channelId) }
    }
    if ((found = /^\/threads\/([^/]+)\/messages$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      if (method === 'GET') {
        // An API from before ranges takes none of their parameters, as it takes no other it doesn't know.
        const ranged = ['after', 'limit', 'order'].find((name) => url.searchParams.has(name))
        if (ranged && !shared.threadRanges) throw new Refused(400, 'invalid_request', `Invalid request: should NOT have additional property \`${ranged}\`.`)
        const after = Number(url.searchParams.get('after') ?? 0)
        const size = Number(url.searchParams.get('limit') ?? 50)
        if (!Number.isInteger(size) || size < 1 || size > 100) throw new Refused(400, 'invalid_request', 'A page holds 1 to 100 messages.')
        const listed = thread.messages.filter((m) => m.sequence > after)
        if (url.searchParams.get('order') === 'desc') listed.reverse()
        const { items, cursor } = page(listed, url.searchParams.get('cursor'), size)
        return { messages: items.map(show), cursor }
      }
      const again = repeat(actor, body.clientId)
      if (again) return again
      // A reply's labels commit with it, and take `label` where it's posted.
      if (Object.keys(body.labels ?? {}).length) tokenMay(actor, 'label', thread.channelId)
      if (Object.keys(body.labels ?? {}).some((key) => key.startsWith('board.'))) throw new Refused(400, 'reserved_label', "Labels under board. are the board's own.")
      return once(actor, body.operationId, () => ({ thread: showThread(thread), message: show(post(actor, thread, body as { text: string; replyTo?: number; clientId?: string; labels?: Record<string, string>; attachments?: string[]; after?: number; noSync?: boolean })) }))
    }
    if ((found = /^\/threads\/([^/]+)\/messages\/(\d+)(\/delete|\/reactions|\/labels)?$/.exec(rest))) {
      const thread = threadAt(found[1]!)
      const message = messageAt(thread.id, Number(found[2]))
      const ref = { threadId: thread.id, message: message.sequence, messageId: message.id }
      const action = found[3] ?? ''
      if (method !== 'GET') tokenMay(actor, action === '/reactions' ? 'react' : action === '/labels' ? 'label' : 'post', thread.channelId)
      if (method === 'PATCH' && action === '') {
        if (!owns(actor, message.createdBy)) throw new Refused(403, 'message_not_owned')
        if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10_000) throw new Refused(400, 'invalid_message', 'A message is 1 to 10000 characters.')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        if (message.text !== body.text) {
          Object.assign(message, { text: body.text, editedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.edited', ...ref, revision: message.revision }, actor)
          if (message.sequence === 1) rootEdited(thread, actor)
        }
        return { message: show(message) }
      }
      if (method === 'POST' && action === '/delete') {
        if (!owns(actor, message.createdBy)) throw new Refused(403, 'message_not_owned')
        if (body.revision !== undefined && body.revision !== message.revision) throw new Refused(409, 'revision_conflict', `The message changed since revision ${body.revision}; it is at revision ${message.revision}.`)
        if (message.deletedAt === undefined) {
          Object.assign(message, { text: '', attachments: undefined, deletedAt: now(), revision: message.revision + 1, changes: message.changes + 1 })
          emit(thread.channelId, { type: 'message.deleted', ...ref, revision: message.revision }, actor)
          if (message.sequence === 1) rootDeleted(thread, actor)
        }
        return { message: show(message) }
      }
      if (method === 'GET' && action === '/reactions') {
        const reactions = [...message.reactions].flatMap(([emoji, by]) => [...by.values()].map(({ actor, createdAt }) => ({ emoji, actor, createdAt })))
        return { reactions, cursor: null }
      }
      if (method === 'POST' && action === '/reactions') {
        if (typeof body.emoji !== 'string' || !EMOJI.test(body.emoji) || Object.hasOwn(Object.prototype, body.emoji)) throw new Refused(400, 'invalid_emoji')
        if (message.deletedAt !== undefined) throw new Refused(409, 'message_deleted')
        const by = message.reactions.get(body.emoji) ?? new Map()
        if (body.remove ? by.has(actor.id) : !by.has(actor.id)) {
          if (body.remove) by.delete(actor.id)
          else by.set(actor.id, { actor, createdAt: now() })
          if (by.size) message.reactions.set(body.emoji, by)
          else message.reactions.delete(body.emoji)
          message.changes++
          emit(thread.channelId, { type: body.remove ? 'message.reaction_removed' : 'message.reaction_added', ...ref, emoji: body.emoji }, actor)
        }
        return { meta: meta(message) }
      }
      if (method === 'POST' && action === '/labels') {
        const set = (body.set ?? {}) as Record<string, string>
        const unset = (body.unset ?? []) as string[]
        if (unset.some((key) => Object.hasOwn(set, key))) throw new Refused(400, 'invalid_label')
        if ([...Object.keys(set), ...unset].some((key) => key.startsWith('board.'))) throw new Refused(400, 'reserved_label', "Labels under board. are the board's own.")
        // What the labels must be now, checked with the change: a value, or null for none. A task's `board.task` reads as any label does.
        const current = labelsOf(message)
        for (const [key, want] of Object.entries((body.if ?? {}) as Record<string, string | null>).sort(([a], [b]) => (a < b ? -1 : 1))) {
          const now = Object.hasOwn(current, key) ? current[key] : undefined
          if (now !== (want ?? undefined)) throw new Refused(409, 'label_conflict', want === null ? `${key} is set` : now === undefined ? `${key} isn't set` : `${key} isn't ${want}`)
        }
        const changes: Record<string, { from?: string; to?: string }> = {}
        for (const key of unset)
          if (Object.hasOwn(message.labels, key)) {
            changes[key] = { from: message.labels[key]! }
            delete message.labels[key]
          }
        for (const [key, value] of Object.entries(set))
          if (message.labels[key] !== value) {
            changes[key] = { ...(Object.hasOwn(message.labels, key) ? { from: message.labels[key]! } : {}), to: value }
            message.labels[key] = value
          }
        if (Object.keys(message.labels).length > 16) throw new Refused(400, 'too_many_labels')
        if (Object.keys(changes).length) {
          message.changes++
          emit(thread.channelId, { type: 'message.labeled', ...ref, labels: changes }, actor)
        }
        return { meta: meta(message) }
      }
    }
    throw new Refused(404, 'not_found', `${method} ${rest}`)
  }

  return {
    route,
    registrations,
    schedules,
    send,
    grants: access.grants,
    within: (actor: Actor, can: Record<string, string[]>) => access.within(whoOf(actor), can),
    cutNextCompletion: () => {
      cut = true
    },
  }
}

/** A board the fake API keeps: who may use it, and what's on it. */
type Kept = {
  id: string
  name: string
  /** The projects granted it, as `prj_x:production`, or `all` for every project in the team. */
  granted: Set<string> | 'all'
  /** For a private board, the people who see it, by user ID; null for a team-visible one. */
  members: Set<string> | null
  data: ReturnType<typeof fakeBoard>
}

/** A name a board may have: 1 to 64 characters, no `/`. */
const BOARD_NAME = /^[^/]{1,64}$/
/** The reads answered with an `ETag`, and a 304 when it's sent back unchanged: a board's channels, one channel, and its actors. */
const TAGGED = /^\/v1\/messageboard\/boards\/[^/]+\/(channels(\/[^/]+)?|actors)$/

/** What `GET /me` says a principal may do, and until when, in milliseconds: the API's `can` and `expiresAt`. */
type MeSays = { can: Record<string, string[]>; expiresAt: number | null }


/** Everything, in the protocol's order: what `GET /me` says an owner, member, or developer may do. */
const ALL = ['read', 'post', 'react', 'label', 'sync', 'manage']

/** A schema version, as the API shows it: a built-in's `createdAt` is 0, and it has no `createdBy`. */
type SchemaRow = { id: string; name: string; version: number; description?: string; schema: Record<string, unknown>; builtIn: boolean; createdAt: number; createdBy?: Actor }

const SCHEMA_KEYWORDS = new Set([
  '$schema', 'type', 'title', 'description', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems', 'minLength', 'maxLength',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'enum', 'const', 'oneOf', 'anyOf', 'allOf', 'not', 'format',
])

/** Whether every schema in `value` uses the API's structural keywords only: `properties` maps names to schemas, and `enum` and `const` hold data. */
function structural(value: unknown, properties = false): boolean {
  if (typeof value !== 'object' || value === null) return true
  if (Array.isArray(value)) return value.every((item) => structural(item))
  return Object.entries(value).every(([key, child]) => (properties ? structural(child) : SCHEMA_KEYWORDS.has(key) && (key === 'enum' || key === 'const' || structural(child, key === 'properties'))))
}

/** `value` as JSON with its keys in order, as the API compares two definitions. */
const sortedJson = (value: unknown): string =>
  JSON.stringify(value, (_key, child) => (child && typeof child === 'object' && !Array.isArray(child) ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => (a < b ? -1 : 1))) : child))

const sha = { type: 'string', pattern: '^(?:[0-9a-f]{40}|[0-9a-f]{64})$', description: 'Full lowercase commit SHA' }
const BUILT_IN_SCHEMAS: SchemaRow[] = [
  {
    id: 'git-commit@1',
    name: 'git-commit',
    version: 1,
    description: 'A Git commit, by its full SHA and the first line of its message.',
    schema: { type: 'object', additionalProperties: false, required: ['sha', 'title'], properties: { sha, title: { type: 'string', minLength: 1, maxLength: 1024 } } },
    builtIn: true,
    createdAt: 0,
  },
  {
    id: 'vercel-deployment@1',
    name: 'vercel-deployment',
    version: 1,
    description: 'A Vercel deployment, by its URL and optionally the commit it was built from.',
    schema: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', format: 'uri', pattern: '^https://', maxLength: 2048 }, gitSha: sha } },
    builtIn: true,
    createdAt: 0,
  },
]

/**
 * The team's data schemas, as Vercel's API keeps them, one registry for every board on the team: its
 * built-ins first, then the team's own by their IDs as text. A version registers once: the same
 * definition again answers it with `created: false`, and another is 409. People and apps
 * register, but for a viewer, and read them on the team's routes, which answer a project's token 403.
 * Whoever a board lets in reads them through it (`/boards/:boardId/schemas…`), a project included.
 */
function fakeSchemas({ now, roles }: { now: () => number; roles: Record<string, Role> }) {
  const kept = new Map<string, SchemaRow>()
  const ID = /^([a-z][a-z0-9._-]{0,79})@([1-9][0-9]{0,4})$/
  return {
    /** Every version the team registered, by its ID. */
    kept,
    /** What a read of `/schemas` or `/schemas/:id` answers, on the team's routes and through a board alike, or undefined for another path. */
    read(path: string): unknown {
      if (path === '/schemas') return { schemas: [...BUILT_IN_SCHEMAS, ...[...kept.values()].sort((a, b) => (a.id < b.id ? -1 : 1))], cursor: null }
      if (!path.startsWith('/schemas/')) return undefined
      const id = decodeURIComponent(path.slice('/schemas/'.length))
      if (!ID.test(id)) throw new Refused(400, 'invalid_schema_id', 'Name a schema as name@version, such as git-commit@1.')
      const schema = BUILT_IN_SCHEMAS.find((found) => found.id === id) ?? kept.get(id)
      if (!schema) throw new Refused(404, 'schema_not_found', `Schema ${id} isn't registered for this team.`)
      return { schema }
    },
    /** What the team's `/schemas…` answers, or undefined for another route. */
    route(method: string, path: string, body: Record<string, any>, actor: Actor): unknown {
      if (path !== '/schemas' && !path.startsWith('/schemas/')) return undefined
      if (actor.principal.type === 'project') throw new Refused(403, 'forbidden')
      if (method === 'GET') return this.read(path)
      if (method !== 'POST' || path !== '/schemas') return undefined
      if (actor.principal.type === 'user' && (roles[actor.principal.userId] ?? 'member') === 'viewer') throw new Refused(403, 'forbidden')
      if (actor.narrowed) throw new Refused(403, 'forbidden', "A caller narrowed with x-board-can can't change the team's schemas: that's its principal's job.")
      const { operationId: _operationId, name, version, description, schema, ...unknown } = body
      if (Object.keys(unknown).length > 0) throw new Refused(400, 'invalid_request', `Unknown property ${Object.keys(unknown)[0]}.`)
      const id = `${name}@${version}`
      if (typeof name !== 'string' || !ID.test(id)) throw new Refused(400, 'invalid_schema_id', 'Schema names use lowercase letters, numbers, ".", "_" and "-", starting with a letter.')
      if (BUILT_IN_SCHEMAS.some((found) => found.name === name)) throw new Refused(409, 'reserved_schema', `${name} is a built-in schema and can't be registered.`)
      if (typeof schema !== 'object' || schema === null || schema.type !== 'object') throw new Refused(400, 'invalid_schema', 'A schema must describe a JSON object ("type": "object").')
      if (!structural(schema)) throw new Refused(400, 'invalid_schema', "Schemas don't support that keyword. References, patterns, uniqueItems, and custom keywords aren't allowed.")
      const existing = kept.get(id)
      if (existing) {
        if (sortedJson(existing.schema) !== sortedJson(schema) || existing.description !== description)
          throw new Refused(409, 'schema_immutable', `${id} is already registered with a different definition. Register a new version instead.`)
        return { schema: existing, created: false }
      }
      const row: SchemaRow = { id, name, version, ...(description !== undefined ? { description } : {}), schema, builtIn: false, createdAt: now(), createdBy: actor }
      kept.set(id, row)
      return { schema: row, created: true }
    },
  }
}

/**
 * The team's API: its default board, `General` (`brd_test`, or none with `boardId: null` until a
 * person makes it), and `boards`, each with the projects granted it as `prj_x:production`. A person
 * uses every board in the team; a project, those granted it in its environment. A board made here
 * takes no name another has, whatever its case, private ones included. A private board (`members`)
 * is seen only by the people it lists.
 * `notDefault`: this team isn't the token's default team, so a request reaches it only when it
 * names it (`teamId` or `slug`), as Vercel's API sends one that names none to the default team.
 *
 * What `GET /me` says, as Vercel's API does: a person may do what their team role lets them
 * (`roles`, by user ID: everything, or `['read', 'react']` for a viewer; a member by default), and a project
 * or an app may read, post, react, and label, and a project sync, everywhere, none with an expiry. `me` says otherwise
 * of some credentials, by the bearer it's sent (`user:u_jb`). A board's `/me` says the same, within what the board's grants give.
 * `me: false` says neither, as Vercel's API answered before it sent them.
 */
export function fakeMessageboard(
  options: {
    teamId?: string
    slug?: string
    boardId?: string | null
    /** False for an API from before it answered actors by their IDs: `GET /actors?id=` is 400. */
    actorsById?: boolean
    /** False for an API that names its actors only to a caller that reads the whole board: `GET /actors` is 403 for one narrowed with `x-board-can`. */
    namesNarrowed?: boolean
    accounts?: Accounts
    boards?: { name: string; id?: string; granted?: string[]; members?: string[] }[]
    /** By user ID: u_jb is an owner and u_val a viewer unless it says, and anyone else a member. */
    roles?: Record<string, Role>
    /** The team's people, by user ID, with their emails: whom a grant's `email` finds. */
    members?: Record<string, string>
    /** The team's projects, by ID, with their names. */
    projects?: Record<string, string>
    /** GitHub repositories, by `owner/repo`, with their IDs. */
    repositories?: Record<string, string>
    me?: Record<string, MeSays> | false
    notDefault?: boolean
    /** True for an API that lists threads with their first and newest messages (`include=messages`). Vercel's doesn't yet: `include` is 400 there. */
    inlineThreadMessages?: boolean
    /** True for an API that lists tasks with their newest messages (`include=messages` on `GET /v2/tasks`). Vercel's doesn't yet: `include` is 400 there. */
    inlineTaskMessages?: boolean
    /** `false`: an API from before its thread list took `limit`, which is 400 there, and every page is 25 threads. Vercel's takes 1 to 100. */
    threadsLimit?: boolean
    /**
     * True for an API that reads a channel by its name (`channel=` in place of `channelId` on a channel's threads, messages,
     * changes, and schedules) and answers a message or a thread with its channel (`include=channel`). Vercel's doesn't yet:
     * each is 400 there, as any parameter it doesn't know is.
     */
    channelNames?: boolean
    /** True for an API that answers a read's actors with it (`with=actors`), as `GET /actors?id=` names them. Vercel's doesn't yet: `with` is 400 there. */
    inlineActors?: boolean
    /** True for an API that pages its channel list by `limit` and lists it by a name's `prefix`. Vercel's doesn't yet: each is 400 there, and it lists every channel. */
    channelPages?: boolean
    /** True for an API that reads a thread's messages in a range (`after`, `limit`, `order`). Vercel's doesn't yet: each is 400 there. */
    threadRanges?: boolean
    /**
     * True for an API that reads the board's feed in one (`GET /changes` with no channel, or with a tree's name, `dev/`),
     * for a caller that reads every channel. Vercel's doesn't yet: a read of changes that names no channel is 400 there.
     */
    boardFeed?: boolean
    /**
     * True for an API that reads a feed's newest events (`GET /changes` with `last`, from 1 to 100): a channel's, a
     * tree's or the board's, oldest first, with the feed's end as the cursor. Vercel's doesn't yet: `last` is a
     * parameter it doesn't know, and 400.
     */
    feedLast?: boolean
    /** How many changes one read of the board's feed passes over, shown to the caller or not: 48 unless this says. */
    feedStretch?: number
    /** False for an API that hands out matches without their message (`currentMessage`), as Vercel's does for a thread moved to a channel the registrant can't read. */
    matchMessages?: boolean
    /** Credentials the API takes, by their bearer, whatever it looks like: the principal each is, as `as()` names it. */
    tokens?: Record<string, string>
    /** An import's author is the platform user alone (`principal: { type: 'external' }`), as Vercel's API named them before platform profiles. */
    externalImports?: boolean
    /** An import's handle is the platform user's own (`Malte Ubl`), as Vercel's API named them before it put them under their project's name. */
    platformHandles?: boolean
    /**
     * A sync key is one registrant's on the whole board, as Vercel's API kept them before each project had its own: a
     * second registrant's is 409 `sync_key_taken`, a registration names no `elsewhere`, and nothing names a binding's project.
     */
    boardWideKeys?: boolean
    /** A deployment's handle is `project:prj_pong:production`, as Vercel's API named one before it named it by its project (`pong`). */
    projectIdHandles?: boolean
    /**
     * Who writes is read as board's protocol has it, as Vercel's API will once it conforms: the profile and its avatar
     * in one structured `x-board-profile` (`fixer;avatar="https://…"`), and `x-board-avatar` and `x-board-session`
     * ignored, as released clients still send them. Without it, as the API reads them today: the name alone in `x-board-profile`, the avatar in
     * `x-board-avatar`, and a session it keeps on the actor.
     */
    protocolProfile?: boolean
    /**
     * Sync's records aren't kept apart, as board can't take for granted of an API it doesn't run: a thread's binding goes
     * to every registrant that syncs its key, another project's included, and `syncThread` lists every target of a thread.
     */
    unscopedSync?: boolean
    /** `false`: an API that serves no task routes, as Vercel's did before its threads carried tasks. Each is its 404, as any route it doesn't have is. */
    tasks?: boolean
    /** True for a team whose plan holds only its own board, as Hobby's does: making another is 400 `too_many_boards`. */
    oneBoard?: boolean
  } = {},
) {
  const accounts = options.accounts ?? ACCOUNTS
  const teamId = options.teamId ?? 'team_test'
  const slug = options.slug ?? 'test'
  const requests: string[] = []
  /** The bucket: bytes by attachment ID, as presigned PUTs leave them. */
  const stored = new Map<string, Uint8Array<ArrayBuffer>>()
  let clock = 0
  const now = () => (clock = Math.max(Date.now(), clock + 1))
  /** When each operation was answered, by its caller: what a retry finds, for 8 days. */
  const receipts = new Map<string, number>()
  const receipt = (actor: Actor, operationId: unknown) => void (typeof operationId === 'string' && receipts.set(`${principalId(actor.principal)}|${operationId}`, Date.now()))
  const roles = options.roles ?? ROLES
  const directory = { members: { ...(options.members ?? MEMBERS) }, roles, projects: options.projects ?? PROJECTS, repositories: options.repositories ?? REPOSITORIES, apps: APPS }
  const shared: Shared = {
    teamId,
    accounts,
    directory,
    now,
    receipt,
    stored,
    inlineThreadMessages: options.inlineThreadMessages ?? false,
    inlineTaskMessages: options.inlineTaskMessages ?? false,
    channelNames: options.channelNames ?? false,
    inlineActors: options.inlineActors ?? false,
    boardFeed: options.boardFeed ?? false,
    feedLast: options.feedLast ?? false,
    feedStretch: options.feedStretch ?? 48,
    threadRanges: options.threadRanges ?? false,
    channelPages: options.channelPages ?? false,
    threadsLimit: options.threadsLimit ?? true,
    feedReads: 0,
    matchMessages: options.matchMessages ?? true,
    externalImports: options.externalImports ?? false,
    actorsById: options.actorsById ?? true,
    namesNarrowed: options.namesNarrowed ?? true,
    platformHandles: options.platformHandles ?? false,
    boardWideKeys: options.boardWideKeys ?? false,
    projectIdHandles: options.projectIdHandles ?? false,
    unscopedSync: options.unscopedSync ?? false,
    tasks: options.tasks ?? true,
    schemaOf: (id) => (BUILT_IN_SCHEMAS.find((row) => row.id === id) ?? schemas.kept.get(id))?.schema,
  }

  const schemas = fakeSchemas({ now, roles })

  const kept = (id: string, name: string, granted: Kept['granted'], members: Kept['members'] = null): Kept => ({ id, name, granted, members, data: fakeBoard(shared, id) })
  // The default board is kept from the start, so what a test reads of it holds once a person makes it.
  const general = kept(options.boardId === undefined ? 'brd_test' : (options.boardId ?? 'brd_default'), 'General', 'all')
  let made = options.boardId !== null
  const others = (options.boards ?? []).map((board) => kept(board.id ?? `brd_${randomUUID()}`, board.name, new Set(board.granted ?? []), board.members ? new Set(board.members) : null))
  const boards = () => [...(made ? [general] : []), ...others]
  /** What each ensure made, by its caller and operation ID, for a retry to answer again. */
  const ensured = new Map<string, Kept>()

  const grantOf = (principal: Extract<Principal, { type: 'project' }>) => `${principal.projectId}:${principal.environment}`
  /**
   * Who uses a board: a project, where it's granted in its environment; a workflow, where it's
   * granted by its principal; a person, a team-visible board, or a private one that lists them.
   */
  const mayUse = (actor: Actor, board: Kept) => {
    const { principal } = actor
    if (principal.type === 'project') return board.granted === 'all' || board.granted.has(grantOf(principal))
    if (principal.type === 'github' || principal.type === 'oidc') return board.granted === 'all' || board.granted.has(principalId(principal))
    return board.members === null || (principal.type === 'user' && board.members.has(principal.userId))
  }
  const show = (board: Kept) => ({ id: board.id, teamId, name: board.name, visibility: board.members === null ? 'team' : 'private' })
  const named = (name: string) => boards().some((board) => board.name.toLowerCase() === name.toLowerCase())

  async function route(request: Request): Promise<unknown> {
    const url = new URL(request.url)
    if (url.searchParams.get('teamId') && url.searchParams.get('teamId') !== teamId) throw new Refused(403, 'forbidden')
    if (url.searchParams.get('slug') && url.searchParams.get('slug') !== slug) throw new Refused(403, 'forbidden')
    if (options.notDefault && !url.searchParams.get('teamId') && !url.searchParams.get('slug')) throw new Refused(403, 'forbidden')
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
    const actor = actorOf(request, options.tokens, options.protocolProfile ?? false, directory.repositories)
    const version = url.pathname.startsWith('/v2/') ? 2 : 1
    const path = url.pathname.replace(/^\/v[12]\/messageboard/, '')
    const method = request.method
    requests.push(`${method} ${version === 2 ? '/v2' : ''}${path}`)
    // Version 2 is a board's task routes alone.
    if (version === 2 && !/^\/boards\/[^/]+\/tasks(\/|$)/.test(path)) throw new Refused(404, 'not_found', `${method} /v2${path}`)
    // Completing an upload takes no body.
    const body = method === 'GET' || /\/attachments\/[^/]+\/complete$/.test(path) ? {} : ((await request.json()) as Record<string, any>)
    // A batch's request, as JSON, before anything of it is read: long texts are over it before they're over the count.
    if (method === 'POST' && /\/tasks\/batch$/.test(path) && new TextEncoder().encode(JSON.stringify(body)).byteLength > BATCH_BODY_BYTES)
      throw new Refused(413, 'entity_too_large', `A request's body is ${BATCH_BODY_BYTES.toLocaleString('en-US')} bytes at most.`)
    // Registering and acking watchers, and completing uploads, take no operation ID: each is idempotent as it is.
    // Sync's routes take none either, but imports.
    if (method !== 'GET' && !/\/watchers(\/|$)|\/complete$|\/sync\/(?!imports$)/.test(path)) {
      if (typeof body.operationId !== 'string') throw new Refused(400, 'invalid_operation_id')
      // Every write's operation ID is a UUIDv7, and its time is read: with no receipt to answer it, a write is refused
      // unless that time is within the last 7 days and at most 5 minutes ahead. A hash laid out as one is almost never.
      if (!UUID_V7.test(body.operationId)) throw new Refused(400, 'invalid_request', 'operationId is a UUIDv7.')
      const kept = receipts.get(`${principalId(actor.principal)}|${body.operationId}`)
      const answered = kept !== undefined && Date.now() - kept <= RECEIPT_KEPT_DAYS * DAY_MS
      const made = Number.parseInt(body.operationId.replaceAll('-', '').slice(0, 12), 16)
      if (!answered && (made < Date.now() - OPERATION_MAX_AGE_DAYS * DAY_MS || made > Date.now() + OPERATION_MAX_SKEW_S * 1000))
        throw new Refused(409, 'operation_expired_or_unknown', "That operation ID's time is not within the last 7 days.", undefined, undefined, { maxAgeDays: OPERATION_MAX_AGE_DAYS, maxClockSkewSeconds: OPERATION_MAX_SKEW_S })
    }
    const me = () => {
      if (options.me === false) return { teamId, actor, view: viewOf(shared, actor) }
      const role = actor.principal.type === 'user' ? (roles[actor.principal.userId] ?? 'member') : null
      // A deployment's own credential may sync too, which no team role says: where, its grants do.
      const can = role === null ? ['read', 'post', 'react', 'label', ...(actor.principal.type === 'project' ? ['sync'] : [])] : role === 'viewer' ? ['read', 'react'] : ALL
      const says = options.me?.[bearer] ?? { can: { '*': can }, expiresAt: null }
      return { teamId, actor, view: viewOf(shared, actor), can: says.can, expiresAt: says.expiresAt }
    }
    if (method === 'GET' && path === '/me') return me()
    if (method === 'GET' && path === '/boards') {
      // `name` matches whatever its case, among the boards the caller may use, in one answer: trimmed and NFC-normalized, as a name is kept.
      const name = url.searchParams.get('name')?.trim().normalize('NFC') ?? null
      if (name !== null && !BOARD_NAME.test(name)) throw new Refused(400, 'invalid_request', 'A board name is 1 to 64 characters with no /.')
      if (name !== null && url.searchParams.has('cursor')) throw new Refused(400, 'invalid_request', 'A name lookup takes no cursor.')
      const listed = boards().filter((board) => mayUse(actor, board) && (name === null || board.name.toLowerCase() === name.toLowerCase()))
      return { boards: listed.map(show), defaultBoardId: made && mayUse(actor, general) ? general.id : null, cursor: null }
    }
    // The team's boards are its principal's to change, not a caller narrowed to some channels.
    if (actor.narrowed && method === 'POST' && (path === '/boards/default' || path === '/boards/ensure')) throw new Refused(403, 'forbidden', "A caller narrowed with x-board-can can't change the team's boards: that's its principal's job.")
    if (method === 'POST' && path === '/boards/default') {
      // Board creates record a person's event, so project tokens can't.
      if (actor.principal.type === 'project') throw new Refused(403, 'forbidden')
      if (!made && named(general.name)) throw new Refused(409, 'board_name_taken')
      made = true
      return { board: show(general) }
    }
    if (method === 'POST' && path === '/boards/ensure') {
      if (typeof body.name === 'string') body.name = body.name.trim().normalize('NFC')
      if (typeof body.name !== 'string' || !BOARD_NAME.test(body.name)) throw new Refused(400, 'invalid_request', 'A board name is 1 to 64 characters with no /.')
      // A retry with the same operation ID answers what the first did, as one that made nothing.
      const replayed = ensured.get(`${principalId(actor.principal)}|${body.operationId}`)
      if (replayed) return { board: show(replayed), created: false }
      const found = boards().filter((board) => board.name.toLowerCase() === body.name.toLowerCase())
      if (found[0]) {
        // A name is taken whoever can see its board: a private one stays unseen, and isn't made again.
        if (found[0].members !== null && !mayUse(actor, found[0])) throw new Refused(409, 'board_name_taken', 'A board has that name.')
        if (!mayUse(actor, found[0])) throw new Refused(403, 'board_not_granted', "This project isn't granted that board.")
        return { board: show(found[0]), created: false }
      }
      if (options.oneBoard) throw new Refused(400, 'too_many_boards', "This team's plan includes only its General board: use General.")
      // A new team-visible board, granted to the project that made it, in its own environment.
      const board = kept(`brd_${randomUUID()}`, body.name, new Set(actor.principal.type === 'project' ? [grantOf(actor.principal)] : []))
      others.push(board)
      ensured.set(`${principalId(actor.principal)}|${body.operationId}`, board)
      receipt(actor, body.operationId)
      return { board: show(board), created: true }
    }
    const registry = schemas.route(method, path, body, actor)
    if (registry !== undefined) return registry
    const onBoard = /^\/boards\/([^/]+)(\/.*)?$/.exec(path)
    const board = onBoard ? boards().find((candidate) => candidate.id === decodeURIComponent(onBoard[1]!)) : undefined
    if (!onBoard || !board || !mayUse(actor, board)) throw new Refused(404, 'board_not_found')
    const rest = onBoard[2] ?? ''
    // A narrowed caller is never its principal's integration: a narrowed register would replace its registration.
    if (actor.narrowed && /^\/(watchers|sync|inbox)(\/|$)/.test(rest)) throw new Refused(403, 'forbidden', "A caller narrowed with x-board-can can't use its principal's watchers or sync's records.")
    if (method === 'GET' && rest === '') {
      // The board itself is read by a caller who reads somewhere on it.
      if (actor.can && !Object.values(actor.can).some((grant) => grant === 'all' || grant.includes('read'))) throw new Refused(403, 'forbidden', 'This caller may not read on this board.')
      return { board: show(board) }
    }
    // The team's schemas, through a board: whoever it lets in reads them.
    if (method === 'GET' && (rest === '/schemas' || rest.startsWith('/schemas/'))) return schemas.read(rest)
    // A board's own me: what the team's says, within what this board's grants give the caller.
    if (method === 'GET' && rest === '/me') {
      const said = me()
      return 'can' in said && said.can ? { ...said, can: board.data.within(actor, said.can) } : said
    }
    return board.data.route(method, rest, url, body, actor, request.signal, version)
  }

  const { registrations, schedules, send, cutNextCompletion } = general.data
  return {
    /**
     * Ends the default board's next completion after its own write, as a request cut off there does: it readies the
     * dependents that fit in that write (15), and the rest wait for the next task request that sees them.
     */
    cutNextCompletion,
    /** Every request it answered, as `METHOD /path`. */
    requests,
    /** How many reads of a channel's feed it took, not counting any it refused for a parameter it doesn't know. */
    feedReads: () => shared.feedReads,
    /** The default board's grants, by ID, as the API keeps them. */
    grants: general.data.grants,
    /** Every schema version the team registered, by ID, as the API keeps them. */
    schemas: schemas.kept,
    /** The watchers each principal registered on the default board, as the API keeps them. */
    registrations,
    /** Every schedule on the default board, by ID, as the API keeps them. */
    schedules,
    /** Posts a default board schedule's next send now, as its timer would: the message's ID. */
    send,
    /** The attachments bucket, as presigned URLs reach it: a PUT stores bytes, held to its signed SHA-256 as S3 holds it, and a GET reads them. */
    files: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      const id = request.url.slice(STORAGE.length)
      if (request.headers.has('authorization')) return new Response('credentials never go to storage', { status: 400 })
      if (request.method === 'PUT') {
        if (stored.has(id)) return new Response(null, { status: 412 })
        const bytes = new Uint8Array(await request.arrayBuffer())
        const digest = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))))
        if (request.headers.get('x-amz-checksum-sha256') !== digest) return new Response('BadDigest', { status: 400 })
        stored.set(id, bytes)
        return new Response(null, { status: 200 })
      }
      const bytes = stored.get(id)
      return bytes ? new Response(bytes) : new Response(null, { status: 404 })
    }) as typeof fetch,
    /** The API, as `fetch` reaches it. */
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      try {
        const answer = await route(request)
        if (request.method !== 'GET' || !TAGGED.test(new URL(request.url).pathname)) return Response.json(answer)
        // A weak tag of what this caller gets, which it sends back to hear it holds.
        const etag = `W/"${createHash('sha256').update(JSON.stringify(answer)).digest('base64url')}"`
        if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } })
        return Response.json(answer, { headers: { etag } })
      } catch (error) {
        if (error instanceof Refused || error instanceof GrantRefused)
          return Response.json({ error: { code: error.code, message: error.message, ...(error instanceof Refused && error.reason !== undefined ? { reason: error.reason } : {}), ...(error instanceof Refused && error.until !== undefined ? { until: error.until } : {}), ...(error instanceof Refused ? error.more : {}) } }, { status: error.status })
        throw error
      }
    }) as typeof fetch,
  }
}

/** A fetch to `api` as `principal` (`user:u_jb`, `project:prj_pong:production`): the bearer token the fake reads. */
export const as = (api: ReturnType<typeof fakeMessageboard>, principal: string): typeof fetch =>
  (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set('authorization', `Bearer ${principal}`)
    return api.fetch(input, { ...init, headers })
  }) as typeof fetch
