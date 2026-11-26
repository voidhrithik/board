import { afterEach, describe, expect, it, vi } from 'vitest'
import { board } from '../src/server/index.ts'
import { http } from '../src/backend-http/index.ts'
import { vercel } from '../src/backend-vercel/index.default.ts'
import type { SandboxMatcher, SandboxPolicy, SandboxPolicyOptions, SandboxRule } from '../src/server/sandbox.ts'
import { BOARD_URL, deploymentToken, PROJECT_ID, testBoard } from './harness.ts'
import { as, fakeMessageboard } from './messageboard.ts'

/**
 * A sandbox's network, as Vercel Sandbox's proxy runs `policy`: a host it doesn't allow is refused,
 * an allowed host's rules run in order and the first that matches handles the request, a transform
 * sets its headers, and a request no rule claims goes on as it is. `reach` is the world past the proxy.
 */
function sandboxNetwork(policy: SandboxPolicy, reach: (request: Request) => Promise<Response>) {
  const blocked: string[] = []
  const test = (matcher: SandboxMatcher | undefined, value: string) => matcher === undefined || ('regex' in matcher ? new RegExp(matcher.regex).test(value) : value === matcher.exact)
  const matches = (rule: SandboxRule, url: URL, request: Request) => {
    const { match } = rule
    if (!match) return true
    if (match.path && !test(match.path, url.pathname)) return false
    if (match.method && !match.method.includes(request.method)) return false
    // Header names match whatever their case, query keys as written.
    const entries = (pairs: [string, string][], each: { key: SandboxMatcher; value?: SandboxMatcher }[], fold: (key: string) => string) =>
      each.every(({ key, value }) => pairs.some(([k, v]) => test('exact' in key ? { exact: fold(key.exact) } : key, fold(k)) && test(value, v)))
    return entries([...url.searchParams], match.queryString ?? [], (key) => key) && entries([...request.headers], match.headers ?? [], (key) => key.toLowerCase())
  }
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const rules = policy.allow[url.host]
    if (!rules) {
      blocked.push(url.host)
      throw new TypeError(`fetch failed: ${url.host} is blocked`)
    }
    const rule = rules.find((candidate) => matches(candidate, url, request))
    if (rule && 'response' in rule) return new Response(rule.response.body ?? null, { status: rule.response.statusCode, headers: rule.response.contentType ? { 'content-type': rule.response.contentType } : {} })
    const headers = new Headers(request.headers)
    for (const transform of rule && 'transform' in rule ? rule.transform : []) for (const [name, value] of Object.entries(transform.headers)) headers.set(name, value)
    return reach(new Request(request, { headers }))
  }) as typeof globalThis.fetch
  return { fetch, blocked }
}

afterEach(() => vi.unstubAllEnvs())

describe("sandboxPolicy() on a board this deployment keeps", () => {
  it("hands a sandbox the board as a profile of this deployment, held to its can, with no credential inside", async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const team = testBoard({ url: BOARD_URL })
    const token = await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL })
    const policy = await team.as({ name: 'fixer', avatar: 'https://example.com/fixer.png' }).sandboxPolicy({ can: { 'dev/': ['read', 'post'] }, token })
    expect(Object.keys(policy.allow)).toEqual([new URL(BOARD_URL).host])
    expect(JSON.stringify(policy)).toContain(token)

    // Its env points vb at the board, with a placeholder for the credential the policy sends instead.
    expect(policy.env).toEqual({ BOARD_URL: (await team.discovery()).url, BOARD_TOKEN: 'set-by-the-network-policy' })
    expect(JSON.stringify(policy.env)).not.toContain(token)

    const network = sandboxNetwork(policy, team.fetch)
    // What runs in the sandbox has no token of its own: its board sends none.
    const agent = board({ backend: http(policy.env.BOARD_URL, { fetch: network.fetch }) }).as(null)
    const posted = await agent.post('dev/fixes', 'on it')
    expect(posted.by).toEqual({ actor: `vercel:project:${PROJECT_ID}:production+fixer`, principal: `vercel:project:${PROJECT_ID}:production`, profile: 'fixer' })
    expect(posted.author).toMatchObject({ kind: 'agent', name: 'fixer', avatar: 'https://example.com/fixer.png', via: { name: 'board', environment: 'production' } })
    expect((await agent.me()).can).toEqual({ 'dev/': ['read', 'post'] })
    await expect(agent.post('ops', 'not here')).rejects.toMatchObject({ status: 403 })
    // Its own profile, whatever it asks for: the policy sets the header.
    expect((await agent.as('claude').post('dev', 'as claude?')).by.profile).toBe('fixer')
  })

  it("withholds what outlasts or outreaches the policy, refuses the rest of the board's host, and reaches no other", async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const team = testBoard({ url: BOARD_URL })
    const token = await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL })
    const network = sandboxNetwork(await team.sandboxPolicy({ token, profile: { name: 'fixer' } }), team.fetch)
    const status = async (path: string, method = 'GET', headers: Record<string, string> = {}) =>
      (await network.fetch(`http://board.test${path}`, { method, headers: { ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, ...(method === 'POST' ? { body: '{}' } : {}) })).status
    // A grant, a watcher, or sync's records would outreach the policy.
    for (const path of ['/api/board/grants', '/api/board/watchers', '/api/board/sync/imports', '/api/board/webhooks/slack', '/api/board/wake'])
      expect([path, await status(path, 'POST')]).toEqual([path, 403])
    // Nor under another name for them: a board mounted without a basePath reads a route as the end of a path.
    for (const path of ['/api/board/x/grants', '/api/board/messages/grants', '/api/board/posts/grants', '/api/board/Grants', '/api/board/x/watchers'])
      expect([path, await status(path, 'POST')]).toEqual([path, 403])
    expect((await team.grants()).map((grant) => grant.id)).toEqual(['g1', 'g2', 'g3'])
    for (const path of ['/api/board/messages/1/../../grants', '/api/board/attachments/x%2F..%2Fgrants', '/api/other', '/', '/api/boardroom', '/api/board//channels'])
      expect([path, await status(path)]).toEqual([path, 403])
    // Deployment Protection's cookie, which would let anyone past it, isn't the sandbox's to ask for.
    expect(await status('/api/board/channels?x-vercel-set-bypass-cookie=true')).toBe(403)
    expect(await status('/api/board/channels', 'GET', { 'x-vercel-set-bypass-cookie': 'true' })).toBe(403)
    expect(await status('/api/board/channels')).toBe(200)
    await expect(network.fetch('https://example.com/exfiltrate')).rejects.toThrow('blocked')
    expect(network.blocked).toEqual(['example.com'])
  })

  it("reads can left out as read, post, react, and label everywhere, and refuses a can or profile that isn't one", async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const team = testBoard({ url: BOARD_URL })
    const token = await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL })
    const agent = board({ backend: http(BOARD_URL, { fetch: sandboxNetwork(await team.as('fixer').sandboxPolicy({ token }), team.fetch).fetch }) }).as(null)
    expect((await agent.me()).can).toEqual({ '*': ['read', 'post', 'react', 'label'] })
    await expect(team.as('fixer').sandboxPolicy({ token, can: 'dev/=fly' })).rejects.toMatchObject({ code: 'invalid_scope' })
    await expect(team.sandboxPolicy({ token, profile: { name: 'not a name' } })).rejects.toMatchObject({ code: 'invalid_profile' })
    await expect(team.sandboxPolicy({ token, profile: { name: 'fixer', avatar: 'http://example.com/f.png' } })).rejects.toMatchObject({ code: 'invalid_profile' })
    // With no profile it names, the sandbox could send any: its deployment's watchers' included.
    await expect(team.sandboxPolicy({ token })).rejects.toMatchObject({ code: 'invalid_profile' })
  })

  it('takes a can in every form its type allows: all, a list for every channel, a map with none, or the header itself', async () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    const team = testBoard({ url: BOARD_URL })
    const token = await deploymentToken('board', PROJECT_ID, 'production', { audience: BOARD_URL })
    const canOf = async (can: SandboxPolicyOptions['can']) => {
      const agent = board({ backend: http(BOARD_URL, { fetch: sandboxNetwork(await team.as('fixer').sandboxPolicy({ token, can }), team.fetch).fetch }) }).as(null)
      return (await agent.me()).can
    }
    expect(await canOf('all')).toEqual({ '*': ['read', 'post', 'react', 'label', 'sync', 'manage'] })
    expect(await canOf(['read'])).toEqual({ '*': ['read'] })
    expect(await canOf({ 'dev/': ['read', 'post'], 'dev/secret': 'none' as never })).toEqual({ 'dev/': ['read', 'post'], 'dev/secret': [] })
    expect(await canOf('dev/=read;ops=all')).toEqual({ 'dev/': ['read'], ops: ['read', 'post', 'react', 'label', 'sync', 'manage'] })
    await expect(team.as('fixer').sandboxPolicy({ token, can: ['fly'] as never })).rejects.toMatchObject({ code: 'invalid_scope' })
  })

  it("on a deployment, adds what gets the sandbox through Deployment Protection, and needs a credential off one", async () => {
    const team = testBoard({ url: 'https://board.example/api/board' })
    for (const key of Object.keys(process.env)) if (/^(VERCEL|BOARD)/.test(key)) vi.stubEnv(key, '')
    // Off Vercel, with no OIDC token pulled, there's nothing to hand the sandbox.
    await expect(team.as('fixer').sandboxPolicy()).rejects.toMatchObject({ code: 'no_token', message: "There's no Vercel OIDC token here to hand a sandbox for https://board.example/api/board." })
    // What a request for the board's channels leaves the sandbox with.
    const headers = async () => {
      let sent: Headers | null = null
      const network = sandboxNetwork(await team.as('fixer').sandboxPolicy({ token: 'oidc-token' }), async (request) => ((sent = request.headers), new Response('{}')))
      await network.fetch('https://board.example/api/board/channels')
      return Object.fromEntries(sent!)
    }
    vi.stubEnv('VERCEL', '1')
    expect(await headers()).toMatchObject({ authorization: 'Bearer oidc-token', 'x-vercel-trusted-oidc-idp-token': 'oidc-token' })
    // This deployment's own bypass goes only to its own hosts.
    vi.stubEnv('VERCEL_AUTOMATION_BYPASS_SECRET', 's3cret')
    expect(await headers()).not.toHaveProperty('x-vercel-protection-bypass')
    vi.stubEnv('VERCEL_URL', 'board.example')
    expect(await headers()).toMatchObject({ 'x-vercel-protection-bypass': 's3cret' })
    expect(await headers()).not.toHaveProperty('x-vercel-trusted-oidc-idp-token')
  })
})

describe("sandboxPolicy() on Vercel's board", () => {
  const API = 'http://localhost'
  it("hands a sandbox the board by its ID and team, as Vercel's API reads who writes today", async () => {
    const api = fakeMessageboard()
    const pong = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }) })
    const policy = await pong.as({ name: 'fixer', avatar: 'https://example.com/fixer.png' }).sandboxPolicy({ token: 'project:prj_pong:production' })
    expect(Object.keys(policy.allow)).toEqual(['localhost'])
    // The URL names the board and its team, as discovery does, so vb in the sandbox finds it from BOARD_URL alone.
    expect(policy.env).toEqual({ BOARD_URL: (await pong.discovery()).url, BOARD_TOKEN: 'set-by-the-network-policy' })
    expect(policy.env.BOARD_URL).toBe(`${API}/v1/messageboard/boards/brd_test?teamId=team_test`)
    const network = sandboxNetwork(policy, (request) => api.fetch(request))
    // The sandbox's vb, pointed at the board's URL, which names its ID and team.
    const agent = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: network.fetch }) })
    const posted = await agent.post('dev', 'on it')
    expect(posted.by).toEqual({ actor: 'vercel:project:prj_pong:production+fixer', principal: 'vercel:project:prj_pong:production', profile: 'fixer' })
    // Another team's board, and the team's other routes, aren't this board.
    expect((await network.fetch(`${API}/v1/messageboard/boards/brd_test/channels?teamId=team_other`)).status).toBe(403)
    expect((await network.fetch(`${API}/v1/messageboard/boards?teamId=team_test`)).status).toBe(403)
    for (const path of ['grants', 'Grants', 'watchers'])
      expect([path, (await network.fetch(`${API}/v1/messageboard/boards/brd_test/${path}?teamId=team_test`, { method: 'POST', body: '{}' })).status]).toEqual([path, 403])
    await expect(pong.as({ name: 'fixer', avatar: 'http://localhost/f.png' }).sandboxPolicy({ token: 'project:prj_pong:production' })).rejects.toMatchObject({ code: 'invalid_profile' })
  })

  it("hands it only the calls an agent's vb makes there, and none of the board's other routes", async () => {
    const api = fakeMessageboard()
    const pong = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }) })
    const network = sandboxNetwork(await pong.as('fixer').sandboxPolicy({ token: 'project:prj_pong:production', can: 'all' }), (request) => api.fetch(request))
    // Its files go to the store's own host, which a caller adds beside the board's.
    const agent = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: network.fetch, files: api.files }) })
    expect((await agent.me()).actor).toBe('vercel:project:prj_pong:production+fixer')
    const root = await agent.post('dev', { text: 'on it', id: 'fix-1' })
    expect((await agent.posted('fix-1'))?.id).toBe(root.id)
    // A message's channel is asked for by its ID through the policy too: a run that has listed nothing lists nothing for it.
    const fresh = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: network.fetch, files: api.files }) })
    api.requests.length = 0
    expect((await fresh.thread(root.id)).message.channel).toBe('dev')
    expect(api.requests.filter((r) => /\/channels(\/[^/]+)?$/.test(r))).toEqual([expect.stringMatching(/^GET .*\/channels\/[^/]+$/)])
    const reply = await agent.reply(root.id, 'a first look')
    await agent.edit(reply.id, 'a closer look')
    await agent.react(root.id, 'eyes')
    await agent.label(root.id, { set: { status: 'fixing' } })
    const file = await agent.upload({ data: new TextEncoder().encode('log'), name: 'log.txt', type: 'text/plain' })
    await agent.reply(root.id, { text: 'the log', attachments: [file.id] })
    expect(await (await agent.download(file.id)).text()).toBe('log')
    const { message, replies } = await agent.thread(root.id)
    expect([message.labels, message.reactions, replies.map((m) => m.text)]).toEqual([{ status: 'fixing' }, { eyes: ['vercel:project:prj_pong:production+fixer'] }, ['a closer look', 'the log']])
    expect((await agent.threads({ channel: 'dev' })).threads.map((t) => t.message.id)).toEqual([root.id])
    expect((await agent.channel('dev').messages()).messages.length).toBeGreaterThan(0)
    expect((await agent.poll({ channel: 'dev', wait: 0 })).cursor).toEqual(expect.any(String))
    expect((await agent.actors()).map((actor) => actor.id)).toContain('vercel:project:prj_pong:production+fixer')
    const later = await agent.schedule({ re: root.id }, { text: 'check back', in: '1h' })
    expect((await agent.schedules()).map((one) => one.id)).toEqual([later.id])
    expect((await agent.cancelSchedule(later.id)).canceled).toBe(true)
    await agent.delete(reply.id)
    // What a project's credential may do to the board itself, or under it past what vb calls, isn't the sandbox's.
    const asked = async (method: string, path: string) => {
      const response = await network.fetch(`${API}/v1/messageboard/boards/brd_test${path}?teamId=team_test`, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) })
      return [method, path, response.status, (await response.json()).error?.message]
    }
    for (const [method, path] of [['DELETE', ''], ['PATCH', ''], ['POST', '/members'], ['DELETE', '/channels/ch_1'], ['GET', '/audit'], ['DELETE', `/threads/x/messages/1`], ['PUT', '/channels']])
      expect(await asked(method!, path!)).toEqual([method, path, 403, "not this board's"])
  })

  it("lets through a read that names its channel by name, and a message asked for with its channel, where the API takes them", async () => {
    const api = fakeMessageboard({ channelNames: true })
    const pong = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }) })
    const root = await pong.post('dev', 'on it')
    await pong.schedule('dev', { text: 'check back', in: '1h' })
    const network = sandboxNetwork(await pong.as('fixer').sandboxPolicy({ token: 'project:prj_pong:production', can: 'all' }), (request) => api.fetch(request))
    const agent = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: network.fetch, files: api.files }) })
    api.requests.length = 0
    expect((await agent.threads({ channel: 'dev' })).threads.map((t) => t.message.id)).toEqual([root.id])
    expect((await agent.channel('dev').messages()).messages.map((m) => m.id)).toEqual([root.id])
    expect((await agent.poll({ channel: 'dev', wait: 0 })).events).toEqual([])
    expect((await agent.schedules({ channel: 'dev' })).map((one) => one.channel)).toEqual(['dev'])
    expect((await agent.thread(root.id)).message.channel).toBe('dev')
    // Every one of them reached the API, and none asked for a channel on the way.
    expect(network.blocked).toEqual([])
    expect(api.requests.filter((r) => /\/channels(\/[^/]+)?$/.test(r))).toEqual([])
  })

  it("hands it the task calls an agent's vb makes there, which are version 2 of the API's, and nothing else at that version", async () => {
    const api = fakeMessageboard()
    const pong = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }) })
    const network = sandboxNetwork(await pong.as('fixer').sandboxPolicy({ token: 'project:prj_pong:production' }), (request) => api.fetch(request))
    const agent = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: network.fetch }) })
    const fixer = 'vercel:project:prj_pong:production+fixer'
    // A queue its deployment fills and the sandbox works: what a claim does, through the policy, on a task that isn't its own.
    const { task: fix } = await pong.tasks.create('work', { text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } })
    const claim = await agent.tasks.claim({ channel: 'work', label: { step: 'fix' }, lease: 60 })
    expect(claim?.task).toMatchObject({ id: fix.id, task: { state: 'claimed', claim: { actor: fixer } } })
    await (await claim!.renew(120)).release()
    await (await agent.tasks.claim(fix.id, { lease: 60 })).block('which branch?', { kind: 'needs_input' })
    await pong.tasks.unblock(fix.id)
    await (await agent.tasks.claim(fix.id, { lease: 60 })).fail('no credentials')
    await pong.tasks.reopen(fix.id)
    await (await agent.tasks.claim(fix.id, { lease: 60 })).complete('fixed in a1b2c3')
    // The tasks it makes are its own to change, a thread it makes one among them.
    const { task: review } = await agent.tasks.create('work', { text: 'review the fix', needs: [fix.id] })
    await agent.tasks.block(review.id, 'not yet')
    await agent.tasks.unblock(review.id)
    await agent.tasks.assign(review.id, fixer)
    await agent.tasks.needs(review.id, [])
    await agent.tasks.needs(review.id, [fix.id])
    await agent.tasks.notBefore(review.id, null)
    await (await agent.tasks.claim(review.id, { lease: 60 })).fail('later')
    await agent.tasks.reopen(review.id)
    const note = await agent.post('work', 'a thread to make a task')
    await agent.tasks.create({ re: note.id })
    await agent.tasks.cancel(note.id, 'not needed')
    // And several at once, which is one call.
    const [build, deploy] = await agent.tasks.createMany('work', [{ key: 'build', text: 'build the fix' }, { text: 'deploy it', needs: [{ key: 'build' }] }])
    expect((await agent.tasks.list({ channel: 'work', state: 'all' })).tasks.map((task) => [task.message.id, task.message.task?.state, task.message.task?.for])).toEqual([
      [fix.id, 'completed', null],
      [review.id, 'ready', fixer],
      [note.id, 'canceled', null],
      [build!.id, 'ready', null],
      [deploy!.id, 'waiting', null],
    ])
    // Its deployment's own aren't: the call is the sandbox's to make, and the API refuses it, so it gives itself none.
    const { task: theirs } = await pong.tasks.create('work', { text: "the deployment's own" })
    await expect(agent.tasks.assign(theirs.id, fixer)).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    await expect(agent.tasks.needs(theirs.id, [fix.id])).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    await expect(agent.tasks.cancel(theirs.id, 'mine now')).rejects.toMatchObject({ status: 403, code: 'task_not_owned' })
    expect((await pong.thread(theirs.id)).message.task).toMatchObject({ state: 'ready', for: null })
    // Nothing else is the sandbox's at that version: a read of one task, which vb never asks for, another change or method, another board or team.
    const asked = async (method: string, path: string, team = 'team_test') => {
      const response = await network.fetch(`${API}/v2/messageboard${path}?teamId=${team}`, { method, ...(method === 'GET' || method === 'DELETE' ? {} : { body: '{}' }) })
      return [method, path, response.status, (await response.json()).error?.message]
    }
    const task = `/boards/brd_test/tasks/thr_${/^msg_(.+)_1$/.exec(fix.id)![1]}`
    for (const [method, path] of [['GET', task], ['DELETE', task], ['POST', `${task}/transfer`], ['GET', `${task}/claim`], ['PUT', '/boards/brd_test/tasks'], ['GET', '/boards/brd_test/tasks/claim'], ['GET', '/boards/brd_test/tasks/batch'], ['POST', '/boards/brd_test/tasks/batch/undo'], ['GET', '/boards/brd_test'], ['GET', '/boards/brd_test/threads'], ['GET', '/boards/brd_other/tasks'], ['GET', '/me']])
      expect(await asked(method!, path!)).toEqual([method, path, 403, "not this board's"])
    expect(await asked('GET', '/boards/brd_test/tasks', 'team_other')).toEqual(['GET', '/boards/brd_test/tasks', 403, "not this board's"])
    expect((await network.fetch(`${API}/v2/messageboard/boards/brd_test/tasks?teamId=team_test`)).status).toBe(200)
  })

  it('holds the sandbox to its can there too, as the API holds a caller to x-board-can', async () => {
    const api = fakeMessageboard()
    const pong = board({ backend: vercel({ team: 'team_test', api: API, fetch: as(api, 'project:prj_pong:production'), files: api.files }) })
    const root = await pong.post('dev', 'a thread to read')
    const policy = await pong.as('fixer').sandboxPolicy({ token: 'project:prj_pong:production', can: { dev: ['read', 'react'] } })
    const agent = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: sandboxNetwork(policy, (request) => api.fetch(request)).fetch }) })
    expect((await agent.me()).can).toEqual({ dev: ['read', 'react'] })
    expect((await agent.thread(root.id)).message.text).toBe('a thread to read')
    await agent.react(root.id, 'eyes')
    await expect(agent.reply(root.id, 'not to post')).rejects.toMatchObject({ status: 403 })
    await expect(agent.post('ops', 'nor here')).rejects.toMatchObject({ status: 403 })
    // Its tasks too: it lists what it reads, and neither makes nor claims one, which take post and label.
    const { task } = await pong.tasks.create('dev', { text: 'a task to leave be' })
    expect((await agent.tasks.list({ channel: 'dev' })).tasks.map((listed) => listed.message.id)).toEqual([task.id])
    await expect(agent.tasks.create('dev', 'not to make')).rejects.toMatchObject({ status: 403 })
    await expect(agent.tasks.claim(task.id)).rejects.toMatchObject({ status: 403 })
    await expect(agent.tasks.claim({ channel: 'dev' })).rejects.toMatchObject({ status: 403 })
    expect((await pong.thread(task.id)).message.task).toMatchObject({ state: 'ready', epoch: 0 })
    // Without a can, read, post, react, and label everywhere: not sync or manage, which this deployment's own credential has.
    const wider = board({ backend: vercel({ team: 'team_test', board: 'brd_test', api: API, fetch: sandboxNetwork(await pong.as('fixer').sandboxPolicy({ token: 'project:prj_pong:production' }), (request) => api.fetch(request)).fetch }) })
    expect((await wider.post('ops', 'here, yes')).by.actor).toBe('vercel:project:prj_pong:production+fixer')
    expect((await wider.me()).can).toEqual({ '*': ['read', 'post', 'react', 'label'] })
    expect((await pong.me()).can).toMatchObject({ '*': expect.arrayContaining(['sync']) })
  })
})
