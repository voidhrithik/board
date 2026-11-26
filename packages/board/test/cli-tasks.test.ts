import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { serve } from './http.ts'
import { personToken } from './harness.ts'
import { url, useBoard, vb } from './cli-harness.ts'
import { asProfile, bo, claimOn, create, deployment, failure, ok, start, task, until } from './cli-tasks-harness.ts'

useBoard()

describe('vb tasks', () => {
  it("runs the spec's opening example: two tasks, the list, the next ready one, its log, its result", async () => {
    const fix = await create('work', 'fix CVE-123 in acme/web', ['--label', 'step=fix'])
    const review = await create('work', 'review the fix for CVE-123', ['--label', 'step=review', '--needs', fix])
    expect(fix).toMatch(/^\d+$/)
    const width = Math.max(fix.length, review.length) + 1
    const row = (id: string, cells: string) => `${`#${id}`.padEnd(width)}  ${cells}\n`
    expect(await ok(['tasks', 'work/'])).toBe(
      row(fix, 'ready      fix CVE-123 in acme/web         step=fix') + row(review, `waiting    review the fix for CVE-123      step=review  needs #${fix}`),
    )

    expect(await ok(['tasks', 'claim', '--ready', 'work/', '--label', 'step=fix', '--wait', '10m'])).toBe(`#${fix}  yours for 15m  fix CVE-123 in acme/web\n`)
    await ok(['reply', fix, 'patched, running the tests'])
    expect(await ok(['tasks', 'complete', fix, 'fixed in a1b2c3, tests pass'])).toBe(`completed ${fix}\n`)

    // What's open is what a queue still has to do; --state all has how the rest ended.
    expect(await ok(['tasks', 'work/'])).toBe(row(review, 'ready      review the fix for CVE-123      step=review'))
    expect(await ok(['tasks', 'work/', '--state', 'all'])).toBe(
      row(fix, 'completed  fix CVE-123 in acme/web         fixed in a1b2c3, tests pass') + row(review, 'ready      review the fix for CVE-123      step=review'),
    )
    expect((await task(fix)).task).toMatchObject({ state: 'completed', result: 'fixed in a1b2c3, tests pass' })
  }, 30_000)

  it('lists by state, label, author, and profile, a page at a time, and says where the next one starts', async () => {
    const ids: string[] = []
    for (const [text, flags] of [
      ['first', ['--label', 'step=fix']],
      ['second', ['--label', 'step=review']],
      ['third', ['--label', 'step=fix', '--for', 'Fixer']],
    ] as const)
      ids.push(await create('queue', text, [...flags]))
    const theirs = await create('queue', "bo's", [], await bo())
    await ok(['tasks', 'block', ids[1]!, 'approve the prod deploy?'])
    const listed = async (...flags: string[]) => (await ok(['tasks', 'queue', ...flags])).trimEnd().split('\n').map((line) => line.split(/ {2,}/).slice(0, 2).join(' '))

    expect(await listed()).toEqual([`#${ids[0]} ready`, `#${ids[1]} blocked`, `#${ids[2]} ready`, `#${theirs} ready`])
    expect(await listed('--state', 'ready', '--label', 'step=fix')).toEqual([`#${ids[0]} ready`, `#${ids[2]} ready`])
    expect(await listed('--state', 'blocked')).toEqual([`#${ids[1]} blocked`])
    expect(await listed('--by', '@u_bo')).toEqual([`#${theirs} ready`])
    expect(await listed('--for', 'fixer')).toEqual([`#${ids[2]} ready`])
    // A held task says what it's held for, where a ready one has its labels.
    expect(await ok(['tasks', 'queue', '--state', 'blocked'])).toBe(`#${ids[1]}  blocked    second                          approve the prod deploy?\n`)
    expect(await ok(['tasks', 'queue', '--state', 'completed'])).toBe('no completed tasks in queue\n')

    // A full page says how to read the next one, and following it does.
    const first = (await ok(['tasks', 'queue', '--limit', '2'])).trimEnd().split('\n')
    const more = /^\(more not shown: (vb tasks queue --limit 2 --after \S+)\)$/.exec(first[2]!)
    expect(first.slice(0, 2).map((line) => line.split(/ {2,}/)[0])).toEqual([`#${ids[0]}`, `#${ids[1]}`])
    expect(more).not.toBeNull()
    const next = (await ok(more![1]!.split(' ').slice(1))).trimEnd().split('\n')
    expect(next.slice(0, 2).map((line) => line.split(/ {2,}/)[0])).toEqual([`#${ids[2]}`, `#${theirs}`])

    // The hint is a command to paste: each word reaches the shell as one, a label's value with a space in it included.
    const spaced = [await create('spaced', 'one', ['--label', 'note=fix it']), await create('spaced', 'two', ['--label', 'note=fix it'])]
    const hinted = (await ok(['tasks', 'spaced', '--label', 'note=fix it', '--limit', '1'])).trimEnd().split('\n')
    expect(hinted[0]!.split(/ {2,}/)[0]).toBe(`#${spaced[0]}`)
    const pasted = /^\(more not shown: vb (.+)\)$/.exec(hinted[1]!)![1]!
    const words = execFileSync('sh', ['-c', `for word in ${pasted}; do printf '%s\\n' "$word"; done`], { encoding: 'utf8' }).trimEnd().split('\n')
    expect(words.slice(0, 6)).toEqual(['tasks', 'spaced', '--label', 'note=fix it', '--limit', '1'])
    expect((await ok(words)).trimEnd().split('\n')[0]!.split(/ {2,}/)[0]).toBe(`#${spaced[1]}`)

    const page = JSON.parse(await ok(['tasks', 'queue', '--limit', '3', '--json'])) as { tasks: { message: MessageView; replies: number; last: MessageView | null }[]; cursor: string }
    expect(page.tasks.map((one) => [one.message.id, one.message.task?.state, one.replies, one.last])).toEqual([[ids[0], 'ready', 0, null], [ids[1], 'blocked', 0, null], [ids[2], 'ready', 0, null]])
    expect(typeof page.cursor).toBe('string')

    expect(await vb(['tasks', 'queue', '--state', 'done'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --state takes a task's state, open, or all, and done isn't one\.\n\n  See how to use it:\n    vb tasks --help\n$/) })
    expect(failure(await vb(['tasks', 'no-such-queue', '--json']))).toMatchObject({ reason: 'channel_not_found', message: "Couldn't find channel no-such-queue." })
    // A channel that's there with nothing in what's asked for is an empty list, as itself and as its subtree, which has no channel under it.
    expect(await ok(['tasks', 'queue', '--state', 'failed'])).toBe('no failed tasks in queue\n')
    expect(await ok(['tasks', 'queue/', '--state', 'failed'])).toBe('no failed tasks in queue/\n')
    expect(failure(await vb(['tasks', 'no-such-queue/', '--json']))).toMatchObject({ reason: 'channel_not_found', message: "Couldn't find channel no-such-queue/." })
    // A word that's nearly a command is a command mistyped, not a channel.
    expect(failure(await vb(['tasks', 'clam', '--json']))).toMatchObject({ reason: 'unknown_command', message: 'Unknown command clam for vb tasks. Did you mean claim?' })
    expect(failure(await vb(['tasks', 'finish', ids[0]!, '--json']))).toMatchObject({ reason: 'unknown_command', message: 'Unknown command finish for vb tasks.' })
  }, 60_000)

  it('creates a task from a channel and its text, or from a thread that is there, as the flags say', async () => {
    // A thread someone else started, made a task as it is: it's still theirs to edit, and its text is theirs.
    const issue = (await ok(['post', 'issues', 'export times out past 10k rows', '--label', 'kind=bug'], await bo())).trim()
    expect(await ok(['tasks', 'create', issue])).toBe(`${issue}\n`)
    expect(await task(issue)).toMatchObject({ text: 'export times out past 10k rows', by: { actor: 'vercel:user:u_bo' }, labels: { kind: 'bug', 'board.task': 'ready' }, task: { state: 'ready', owner: 'vercel:user:u_julian' } })
    const refused = await vb(['tasks', 'create', issue, 'mine now'])
    expect(refused).toMatchObject({ code: 2, stdout: '' })
    expect(refused.stderr).toBe(`error: #${issue} becomes a task as it is: text is for a new thread.\n\n  Make it a task as it is:\n    vb tasks create ${issue}\n`)
    expect((await vb(['tasks', 'create', issue, '--label', 'step=fix'])).code).toBe(2)

    // --for is one of your own profiles, and --needs the tasks it waits for.
    const waiting = JSON.parse(await ok(['tasks', 'create', 'made', 'review it', '--needs', `#${issue}`, '--for', 'Reviewer', '--json'])) as { task: MessageView; outcome: string }
    expect(waiting).toMatchObject({ outcome: 'created', task: { text: 'review it', task: { state: 'waiting', needs: [issue], for: 'vercel:user:u_julian+reviewer' } } })

    // The same key again is the same task; the text can come from stdin.
    const once = await create('made', 'deploy a1b2c3', ['--idempotency-key', 'deploy-a1b2c3'])
    expect(await create('made', 'deploy a1b2c3', ['--idempotency-key', 'deploy-a1b2c3'])).toBe(once)
    const piped = (await ok(['tasks', 'create', 'made', '-'], {}, 'from stdin\n')).trim()
    expect((await task(piped)).text).toBe('from stdin')

    // --claim holds it from the start, for the lease it asks for.
    const held = await ok(['tasks', 'create', 'made', 'a step of my own', '--claim', '--lease', '1m'])
    const id = /^#(\d+) {2}yours for 1m {2}a step of my own\n$/.exec(held)?.[1]
    expect(id).toBeDefined()
    expect((await task(id!)).task).toMatchObject({ state: 'claimed', epoch: 1 })
    expect(await ok(['tasks', 'complete', id!])).toBe(`completed ${id}\n`)

    expect(await vb(['tasks', 'create', 'made', 'x', '--lease', '5m'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --lease is how long a claim holds the task: pass --claim too\.\n/) })
    expect(await vb(['tasks', 'create'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing a channel to start a task in, or a thread's ID to make one of\.\n/) })
    expect(failure(await vb(['tasks', 'create', 'made', 'after nothing', '--needs', piped.replace(/\d$/, '99999'), '--json']))).toMatchObject({
      reason: 'invalid_needs',
      message: "Can't create a task in made. --needs takes tasks you can read.",
      next: [{ command: 'vb tasks --state all' }],
    })
  }, 60_000)

  it("says who a new task's text mentions, and warns for a handle that mentions no one", async () => {
    // A Vercel login's handle and name are its user ID, and it's known once it has written.
    await ok(['post', 'mentions', 'hello'])
    const made = await vb(['tasks', 'create', 'mentions', 'for @u_julian and @nobody'])
    expect(made).toMatchObject({ code: 0, stderr: 'warning: @nobody names no one here: it stays text, and mentions no one.\n' })
    const [id, ...said] = made.stdout.trimEnd().split('\n')
    expect(said).toEqual(['mentioned  u_julian  @u_julian'])
    expect((await task(id!)).text).toBe('for @[vercel:user:u_julian] and @nobody')
    // With --json they're in the result, with the warning.
    const again = JSON.parse((await vb(['tasks', 'create', 'mentions', 'and @u_julian again', '--json'])).stdout)
    expect(again.mentions).toEqual([{ written: '@u_julian', actor: { id: 'vercel:user:u_julian', handle: 'u_julian', name: 'u_julian' }, candidates: [] }])
    expect(again.task.text).toBe('and @[vercel:user:u_julian] again')
  })

  it('claims a task by its ID for a lease, and tells a second claim who to ask', async () => {
    const id = await create('claims', 'migrate the table')
    expect(await ok(['tasks', 'claim', `#${id}`, '--lease', '30s'])).toBe(`#${id}  yours for 30s  migrate the table\n`)
    expect((await task(id)).task).toMatchObject({ state: 'claimed', epoch: 1, claim: { actor: 'vercel:user:u_julian' } })

    const taken = await vb(['tasks', 'claim', id], await bo())
    expect(taken).toMatchObject({ code: 1, stdout: '' })
    expect(taken.stderr).toMatch(new RegExp(`^error: Can't claim task #${id}\\. Someone holds it\\.\\n  [^\\n]+\\n\\n  See who holds it, and until when:\\n    vb read ${id}\\n$`))
    expect(failure(await vb(['tasks', 'claim', id, '--json'], await bo()))).toMatchObject({ reason: 'task_claimed', next: [{ argv: ['vb', 'read', id] }], data: { error: { code: 'task_claimed', status: 409 } } })

    // The claim, for a program: the task, the epoch, and when it ends. Its token stays with the CLI.
    const other = await create('claims', 'a second one')
    const claimed = await ok(['tasks', 'claim', other, '--json'])
    const { claim, task: root } = JSON.parse(claimed) as { claim: Record<string, unknown>; task: MessageView }
    expect(Object.keys(claim).sort()).toEqual(['epoch', 'until'])
    expect(Date.parse(String(claim.until)) - Date.now()).toBeGreaterThan(14 * 60_000)
    expect(root).toMatchObject({ id: other, task: { state: 'claimed' } })
    const [stored] = await claimOn(other)
    expect(stored?.token).toMatch(/^[\w-]{22}$/)
    expect(claimed).not.toContain(stored!.token)

    for (const flag of [['--label', 'step=fix'], ['--from', 'bo'], ['--wait', '1m']])
      expect(await vb(['tasks', 'claim', id, ...flag]), flag[0]).toMatchObject({ code: 2, stderr: expect.stringMatching(new RegExp(`^error: ${flag[0]} goes with --ready`)) })
    // A lease is a duration the board would take, said before it's asked.
    for (const lease of ['10', 'soon']) expect(await vb(['tasks', 'claim', id, '--lease', lease]), lease).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --lease takes a duration like 30s or 10m/) })
    for (const lease of ['10s', '2h']) expect(await vb(['tasks', 'claim', id, '--lease', lease]), lease).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: --lease takes 30s to 1h/) })
    expect(await vb(['tasks', 'claim'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing the task to claim: its ID, or --ready and a channel\.\n/) })
  }, 60_000)

  it("claims the next ready task by label, takes another owner's only when --from names them, and says when nothing is ready", async () => {
    const review = await create('next', 'review', ['--label', 'step=review'])
    const fix = await create('next/web', 'fix', ['--label', 'step=fix'])
    const theirs = await create('next', "bo's fix", ['--label', 'step=fix'], await bo())

    // The channel alone leaves out what's under it, and a task of Bo's is Bo's to hand out.
    const none = await vb(['tasks', 'claim', '--ready', 'next', '--label', 'step=fix'])
    expect(none).toMatchObject({ code: 1, stdout: '' })
    expect(none.stderr).toBe("error: Nothing is ready in next.\n\n  Wait for one:\n    vb tasks claim --ready next --label step=fix --wait 10m\n  Or see what's there:\n    vb tasks next\n")
    expect(failure(await vb(['tasks', 'claim', '--ready', 'next', '--label', 'step=fix', '--json'])).reason).toBe('nothing_ready')
    expect(await ok(['tasks', 'claim', '--ready', 'next/', '--label', 'step=fix'])).toBe(`#${fix}  yours for 15m  fix\n`)
    // A handle is how someone shows, and several can share one, so it names no owner: Bo's ID does.
    const picked = await vb(['tasks', 'claim', '--ready', 'next', '--label', 'step=fix', '--from', 'bo'])
    expect(picked).toMatchObject({ code: 2, stdout: '' })
    expect(picked.stderr).toMatch(/^error: Can't claim a task in next\. --from takes an owner's ID: several can share a handle\.\n  [^\n]+\n\n  See everyone's IDs:\n    vb actors\n$/)
    expect(failure(await vb(['tasks', 'claim', '--ready', 'next', '--from', 'bo', '--json']))).toMatchObject({ reason: 'invalid_from', data: { error: { code: 'invalid_from', status: 400 } } })
    expect(await ok(['tasks', 'claim', '--ready', 'next', '--label', 'step=fix', '--from', 'vercel:user:u_bo', '--lease', '5m'])).toBe(`#${theirs}  yours for 5m  bo's fix\n`)
    // A project's handle is the one its token gave it, which the board checked, and one on another team can have it too.
    const deployed = await create('next', 'roll back www', ['--label', 'step=ops'], await deployment())
    expect(failure(await vb(['tasks', 'claim', '--ready', 'next', '--label', 'step=ops', '--from', 'web', '--json'])).reason).toBe('invalid_from')
    expect(await ok(['tasks', 'claim', '--ready', 'next', '--label', 'step=ops', '--from', 'vercel:project:prj_web:production'])).toBe(`#${deployed}  yours for 15m  roll back www\n`)
    expect(await ok(['tasks', 'claim', '--ready', 'next'])).toBe(`#${review}  yours for 15m  review\n`)

    // A wait that runs out is a timeout, as `wait`'s is.
    const waited = await vb(['tasks', 'claim', '--ready', 'next/', '--wait', '1s', '--json'])
    expect(waited.code).toBe(1)
    expect(failure(waited)).toMatchObject({ reason: 'timeout', message: 'Nothing was ready in next/ within 1s.' })
    expect(await vb(['tasks', 'claim', '--ready'])).toMatchObject({ code: 2, stderr: expect.stringMatching(/^error: Missing the channel to claim a task in/) })
    expect((await vb(['tasks', 'claim', '--ready', 'next', '--wait', 'a while'])).code).toBe(2)
  }, 60_000)

  it("refuses the list's label filters on claim --ready and run --ready, which match one value exactly, with the claim of one", async () => {
    const worker = await create('roles', 'build it', ['--label', 'role=worker'])
    await create('roles', 'review it', ['--label', 'role=reviewer'])
    // The list takes either value, or the key alone.
    for (const label of ['role=worker|reviewer', 'role']) expect((await ok(['tasks', 'roles', '--label', label])).trimEnd().split('\n')).toHaveLength(2)
    // A claim would match neither, and wait out its --wait for a task labeled `worker|reviewer`: it says so before it asks.
    const either = await vb(['tasks', 'claim', '--ready', 'roles', '--label', 'role=worker|reviewer', '--wait', '1m'])
    expect(either).toEqual({
      code: 2,
      stdout: '',
      stderr: [
        'error: --label on claim --ready takes one value: role=worker|reviewer has 2, and a claim matches one exactly.',
        '',
        '  Claim one with role=worker:',
        '    vb tasks claim --ready roles --label role=worker --wait 1m',
        "  See what's ready, and their labels:",
        "    vb tasks roles --state ready --label 'role=worker|reviewer'",
        '',
      ].join('\n'),
    })
    const bare = await vb(['tasks', 'run', '--ready', 'roles', '--label=role', '--', 'true'])
    expect([bare.code, bare.stdout, bare.stderr.split('\n')]).toEqual([2, '', ['error: --label on run --ready takes key=value: role has no value, and a claim matches one exactly.', '', "  See what's ready, and their labels:", '    vb tasks roles --state ready --label role', '']])
    // What it says to run claims the task.
    const claim = failure(await vb(['tasks', 'run', '--ready', 'roles', '--label=role=worker|reviewer', '--json', '--', 'true'])).next![0]!
    expect(claim.argv).toEqual(['vb', 'tasks', 'run', '--ready', 'roles', '--label=role=worker', '--json', '--', 'true'])
    expect(JSON.parse((await ok(claim.argv.slice(1))))).toMatchObject({ task: { id: worker } })
    // The command after -- is run's to hand over as it is: the same label there is its own, and stays.
    const own = failure(await vb(['tasks', 'run', '--ready', 'roles', '--label', 'role=worker|reviewer', '--json', '--', 'echo', '--label', 'role=worker|reviewer', '--label=role=worker|reviewer']))
    expect(own.next![0]!.argv).toEqual(['vb', 'tasks', 'run', '--ready', 'roles', '--label', 'role=worker', '--json', '--', 'echo', '--label', 'role=worker|reviewer', '--label=role=worker|reviewer'])
    // One with no key says so, not that it has no value.
    const keyless = await vb(['tasks', 'claim', '--ready', 'roles', '--label', '=worker'])
    expect([keyless.code, keyless.stderr.split('\n')[0]]).toEqual([2, 'error: --label on claim --ready takes key=value, and =worker has no key before its =.'])
  }, 60_000)

  it("says where a result or reason goes when the board refuses it as too long", async () => {
    const id = await create('notes', 'run the suite')
    await ok(['tasks', 'claim', id])
    const long = 'a'.repeat(1001)
    const reply = { argv: ['vb', 'reply', id, '-'] }
    expect(failure(await vb(['tasks', 'complete', id, long, '--json']))).toMatchObject({
      reason: 'payload_too_large',
      message: `Can't complete task #${id}. Its result is too long for the board.`,
      data: { error: { message: "result: a task's result is at most 1,000 characters" } },
      next: [reply, { argv: ['vb', 'tasks', 'complete', id, '<A LINE OR TWO>'] }],
    })
    expect(failure(await vb(['tasks', 'fail', id, long, '--json']))).toMatchObject({ reason: 'payload_too_large', next: [reply, { argv: ['vb', 'tasks', 'fail', id, '<A LINE OR TWO>'] }] })
    expect((await task(id)).task).toMatchObject({ state: 'claimed' })
    expect(await ok(['tasks', 'complete', id, 'a'.repeat(1000)])).toBe(`completed ${id}\n`)
    // The command ran: what's left is completing the task it still holds, not running it again.
    const ran = await create('notes', 'run it again')
    expect(failure(await vb(['tasks', 'run', ran, '--json', '--result', long, '--', 'true']))).toMatchObject({
      reason: 'payload_too_large',
      next: [{ argv: ['vb', 'reply', ran, '-'] }, { argv: ['vb', 'tasks', 'complete', ran, '<A LINE OR TWO>'] }],
    })
    expect(await ok(['tasks', 'complete', ran, 'tests pass'])).toBe(`completed ${ran}\n`)
    // With --ready, the command line names a channel: the way on names the task it claimed.
    const ready = await create('notes', 'one more')
    expect(failure(await vb(['tasks', 'run', '--ready', 'notes', '--json', '--result', long, '--', 'true']))).toMatchObject({
      reason: 'payload_too_large',
      next: [{ argv: ['vb', 'reply', ready, '-'] }, { argv: ['vb', 'tasks', 'complete', ready, '<A LINE OR TWO>'] }],
    })
    expect(await ok(['tasks', 'complete', ready, 'tests pass'])).toBe(`completed ${ready}\n`)
  }, 30_000)

  it('waits for a task that becomes ready, and stops quietly on Ctrl-C', async () => {
    const build = await create('pipeline', 'build the image')
    const deploy = await create('pipeline', 'deploy it', ['--label', 'step=deploy', '--needs', build])
    const waiting = start(['tasks', 'claim', '--ready', 'pipeline', '--label', 'step=deploy', '--wait', '1m'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(waiting.printed.stdout).toBe('')
    // Its prerequisite completes while it waits, and the claim is the waiter's.
    await ok(['tasks', 'run', build, '--', process.execPath, '-e', ''])
    expect(await waiting.exited).toBe(0)
    expect(waiting.printed).toEqual({ stdout: `#${deploy}  yours for 15m  deploy it\n`, stderr: '' })

    const idle = start(['tasks', 'claim', '--ready', 'pipeline', '--label', 'step=never', '--wait', '1m'])
    await new Promise((resolve) => setTimeout(resolve, 1500))
    idle.child.kill('SIGINT')
    expect(await idle.exited).toBe(130)
    expect(idle.printed).toEqual({ stdout: '', stderr: '' })
  }, 60_000)

  it("says a thread isn't a task, or is one already, and how to go on from there", async () => {
    const plain = (await ok(['post', 'plain', 'just a thread'])).trim()
    const none = await vb(['tasks', 'claim', plain])
    expect(none).toEqual({ code: 1, stdout: '', stderr: `error: #${plain} isn't a task.\n\n  Make it one:\n    vb tasks create ${plain}\n` })
    await ok(['tasks', 'create', plain])
    expect(await vb(['tasks', 'create', plain])).toEqual({ code: 1, stdout: '', stderr: `error: #${plain} is a task already.\n\n  See it:\n    vb read ${plain}\n` })
    expect(await vb(['tasks', 'claim', '999999'])).toEqual({ code: 1, stdout: '', stderr: "error: Couldn't find message #999999.\n" })

    const after = await create('plain', 'after it', ['--needs', plain])
    const waiting = await vb(['tasks', 'claim', after])
    expect(waiting.stderr).toMatch(new RegExp(`^error: Can't claim task #${after}\\. It waits for other tasks\\.\\n  [^\\n]+\\n\\n  See what it waits for:\\n    vb read ${after}\\n$`))
  }, 60_000)

  it("names the tasks command for a change someone tried to make by labeling board.task", async () => {
    const id = await create('reserved', 'fix CVE-123')
    const tried = async (...args: string[]) => {
      const ran = await vb(args)
      expect(ran, args.join(' ')).toMatchObject({ code: 2, stdout: '' })
      const [headline, , , ...ways] = ran.stderr.trimEnd().split('\n')
      return [headline, ...ways.map((line) => line.trim())]
    }
    const headline = `error: Can't label #${id}. Labels under board. are the board's own.`
    expect(await tried('label', id, 'board.task=completed')).toEqual([headline, 'Complete it, with the claim you hold:', `vb tasks complete ${id}`])
    expect(await tried('label', id, 'board.task=claimed')).toEqual([headline, 'Claim it:', `vb tasks claim ${id}`])
    expect(await tried('label', id, 'step=fix', 'board.task=canceled')).toEqual([headline, 'Cancel it:', `vb tasks cancel ${id} <REASON>`])
    expect(await tried('label', id, 'board.task=blocked')).toEqual([headline, 'Hold it for a person:', `vb tasks block ${id} <REASON>`])
    expect(await tried('label', id, 'board.task=failed')).toEqual([headline, 'Fail it, with the claim you hold:', `vb tasks fail ${id} <REASON>`])
    expect(await tried('label', id, 'board.task=ready')).toEqual([headline, 'Make the thread a task:', `vb tasks create ${id}`, 'Or lift a hold on one:', `vb tasks unblock ${id}`])
    expect(await tried('label', id, '--unset', 'board.task')).toEqual([headline, 'Cancel the task:', `vb tasks cancel ${id} <REASON>`])
    expect(await tried('post', 'reserved', 'looks ready', '--label', 'board.task=ready')).toEqual(["error: Can't post to reserved. Labels under board. are the board's own.", 'Start it as a task:', 'vb tasks create reserved <TEXT>'])
    // Another key under board. is the board's too, with no command of its own to name.
    expect((await vb(['label', id, 'board.note=x'])).stderr).toBe(`error: Can't label #${id}. Labels under board. are the board's own.\n  board.note is the board's own label: only its task writes set labels under board.\n`)
    expect(failure(await vb(['label', id, 'board.task=completed', '--json']))).toMatchObject({ reason: 'reserved_label', next: [{ argv: ['vb', 'tasks', 'complete', id] }], data: { error: { code: 'reserved_label' } } })
    expect(await task(id)).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })
  }, 60_000)

  it('says a board keeps no tasks where it answers so', async () => {
    // A board in front of this one that keeps none, as one on Vercel's API answers today.
    const taskless = await serve(async (request) => {
      const to = new URL(request.url)
      if (/\/tasks(\/|$)/.test(to.pathname)) return Response.json({ error: { code: 'no_tasks', message: 'this board keeps no tasks' } }, { status: 501 })
      return fetch(new Request(`${url}${to.pathname.slice('/api/board'.length)}${to.search}`, request))
    })
    const board = `${taskless.origin}/api/board`
    const as = { BOARD_URL: board, BOARD_TOKEN: await personToken('u_julian', board) }
    try {
      for (const [args, doing] of [
        [['tasks'], 'list tasks'],
        [['tasks', 'create', 'work', 'fix it'], 'create a task in work'],
        [['tasks', 'claim', '812'], 'claim task #812'],
        [['tasks', 'claim', '--ready', 'work/'], 'claim a task in work/'],
        [['tasks', 'cancel', '812', 'no'], 'cancel task #812'],
      ] as const) {
        const ran = await vb([...args], as)
        expect(ran, args.join(' ')).toEqual({ code: 1, stdout: '', stderr: `error: Can't ${doing}. This board keeps no tasks.\n  this board keeps no tasks\n  Board           ${board}\n` })
      }
      expect(failure(await vb(['tasks', '--json'], as)).reason).toBe('no_tasks')
    } finally {
      await taskless.close()
    }
  }, 60_000)

  it("shows a task's state under its root in read, and what happens to it in tail", async () => {
    const tail = start(['tail', 'shown'])
    // Once it's following, what happens next reaches it.
    await until(async () => {
      await ok(['post', 'shown', 'is anyone following?'])
      return tail.printed.stdout.includes('is anyone following?')
    }, 'tail to follow')
    const first = await create('shown', 'fix CVE-123', ['--label', 'step=fix'])
    const second = await create('shown', 'review it', ['--needs', first, '--for', 'reviewer'])
    const worker = asProfile('claude')
    await ok(['tasks', 'claim', first], worker)

    // Who holds it and for how long, in the reader's own row style; the claimant is named as a message's author is.
    expect(await ok(['read', first])).toMatch(new RegExp(`^#${first}  u_julian · \\d+s  \\[step=fix board\\.task=claimed\\]\\n      fix CVE-123\\n      task  claimed by claude via u_julian · 15m left\\n$`))
    expect(await ok(['read', second])).toMatch(new RegExp(`\\n      review it\\n      task  waiting · needs #${first} · for reviewer\\n$`))
    await ok(['tasks', 'complete', first, 'fixed in a1b2c3'], worker)
    expect(await ok(['read', first])).toMatch(/\n {6}task {2}completed · fixed in a1b2c3\n$/)
    await ok(['tasks', 'block', second, 'approve?', '--kind', 'awaiting_approval'])
    expect(await ok(['read', second])).toMatch(new RegExp(`\\n      task  blocked · awaiting_approval · approve\\? · needs #${first} · for reviewer\\n$`))
    // Someone else's thread, made a task: whose task it is isn't its author.
    const issue = (await ok(['post', 'shown', 'export times out'], await bo())).trim()
    await ok(['tasks', 'create', issue])
    expect(await ok(['read', issue])).toMatch(/\n {6}task {2}ready · owner u_julian\n$/)
    await ok(['tasks', 'cancel', issue, 'duplicate'])
    // The rest of what happens to a task, each a line that says who did it.
    const third = await create('shown', 'deploy it')
    await ok(['tasks', 'assign', third, 'Fixer'])
    await ok(['tasks', 'assign', third, '--pool'])
    await ok(['tasks', 'claim', third], worker)
    await ok(['tasks', 'renew', third], worker)
    await ok(['tasks', 'release', third], worker)
    await ok(['tasks', 'unblock', second])
    await ok(['tasks', 'claim', third], worker)
    await ok(['tasks', 'fail', third, 'no credentials'], worker)
    await ok(['tasks', 'reopen', third])
    // What it waits for, changed by its owner: for another task now, then for nothing.
    await ok(['tasks', 'needs', third, second, first])
    await ok(['tasks', 'needs', third, '--none'])
    // When it's due, set by its owner when it's made and after.
    const fourth = await create('shown', 'renew the cert', ['--due', '2099-12-01T17:00Z'])
    await ok(['tasks', 'due', fourth, '2099-12-02T09:30Z'])
    await ok(['tasks', 'due', fourth, '--none'])

    const lines = [
      `#${first}  shown  task created by u_julian`,
      `#${second}  shown  task created by u_julian · needs #${first} · for reviewer`,
      `#${first}  shown  task claimed by claude via u_julian`,
      `#${first}  shown  task completed by claude via u_julian · fixed in a1b2c3`,
      `#${second}  shown  task ready`,
      `#${second}  shown  task blocked by u_julian · awaiting_approval · approve?`,
      `#${issue}  shown  task created by u_julian`,
      `#${issue}  shown  task canceled by u_julian · duplicate`,
      `#${third}  shown  task created by u_julian`,
      `#${third}  shown  task assigned to fixer by u_julian`,
      `#${third}  shown  task unassigned by u_julian`,
      `#${third}  shown  task claimed by claude via u_julian`,
      // A renewal is the claim's bookkeeping: the task is where it was, so nothing is printed.
      `#${third}  shown  task released by claude via u_julian`,
      `#${second}  shown  task unblocked by u_julian`,
      `#${second}  shown  task ready`,
      `#${third}  shown  task claimed by claude via u_julian`,
      `#${third}  shown  task failed by claude via u_julian · no credentials`,
      `#${third}  shown  task reopened by u_julian`,
      `#${third}  shown  task needs #${second} #${first} by u_julian`,
      `#${third}  shown  task needs nothing by u_julian`,
      `#${fourth}  shown  task created by u_julian · due 2099-12-01T17:00Z`,
      `#${fourth}  shown  task due 2099-12-02T09:30Z by u_julian`,
      `#${fourth}  shown  task no due date by u_julian`,
    ]
    await until(() => tail.printed.stdout.includes(lines.at(-1)!), 'tail to print the last of them')
    tail.child.kill('SIGINT')
    expect(await tail.exited).toBe(130)
    expect(tail.printed.stdout.split('\n').filter((line) => /  task /.test(line))).toEqual(lines)
    // A task's line names the task, never a bare cursor and type.
    expect(tail.printed.stdout).not.toMatch(/task\.[a-z]+/)
  }, 90_000)
})
