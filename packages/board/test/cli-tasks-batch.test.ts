import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { MessageView } from '../src/api/routes.ts'
import { tmp, useBoard, vb } from './cli-harness.ts'
import { create, failure, ok, task } from './cli-tasks-harness.ts'

// `vb tasks create <channel> --file`: a plan of tasks from a JSON file, against a served local board.

useBoard()

/** A plan, written where a run reads it. */
async function planFile(tasks: unknown, name = 'plan.json'): Promise<string> {
  const path = join(await tmp('board-plan-'), name)
  await writeFile(path, typeof tasks === 'string' ? tasks : JSON.stringify(tasks))
  return path
}

const rows = (stdout: string) => stdout.split('\n').filter(Boolean)
const idOf = (row: string) => /^#(\S+)/.exec(row)![1]!

describe('vb tasks create --file', () => {
  it('makes the tasks a JSON file holds, each waiting for the ones it names, and prints them as the list does', async () => {
    const before = await create('plans', 'cut the release branch')
    const path = await planFile([
      { key: 'fix', text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } },
      // A bare string that's a key of the plan's own names that task.
      { key: 'review', text: 'review the fix for CVE-123', labels: { step: 'review' }, needs: ['fix'] },
      // What was there is named by its ID, written as the CLI prints it, as JSON has a number, or as { id }, and an assignee by a profile's name.
      { text: 'ship it', needs: [{ key: 'review' }, `#${before}`, Number(before), { id: before }], for: 'Shipper', priority: 2 },
    ])
    const made = await vb(['tasks', 'create', 'plans', '--file', path, '--idempotency-key', 'cve-123'])
    expect(made).toMatchObject({ code: 0, stderr: '' })
    const [fix, review, ship] = rows(made.stdout).map(idOf)
    // A line a task, as `vb tasks` shows them: the same rows, after the one that was there.
    const listed = await ok(['tasks', 'plans'])
    expect(rows(listed).slice(1)).toEqual(rows(made.stdout))
    expect(rows(made.stdout).map((row) => row.replace(/\s+/g, ' '))).toEqual([
      `#${fix} ready fix CVE-123 in acme/web step=fix`,
      `#${review} waiting review the fix for CVE-123 step=review needs #${fix}`,
      `#${ship} waiting ship it needs #${before} #${review} priority 2`,
    ])
    expect((await task(ship!)).task).toMatchObject({ state: 'waiting', needs: [before, review], for: expect.stringMatching(/\+shipper$/), priority: 2 })
    // The same key and file again make nothing: the tasks, as they are now.
    await ok(['tasks', 'claim', fix!])
    const again = await ok(['tasks', 'create', 'plans', '--file', path, '--idempotency-key', 'cve-123'])
    expect(rows(again).map((row) => row.replace(/\s+/g, ' ').split(' ').slice(0, 2))).toEqual([[`#${fix}`, 'claimed'], [`#${review}`, 'waiting'], [`#${ship}`, 'waiting']])
    expect(rows(await ok(['tasks', 'plans']))).toHaveLength(4)
    // Without a key, the same file again is the same tasks again.
    await ok(['tasks', 'create', 'plans', '--file', path])
    expect(rows(await ok(['tasks', 'plans']))).toHaveLength(7)
    // The key with another plan is another write's.
    const other = await planFile([{ text: 'another plan under the same key' }])
    const reused = await vb(['tasks', 'create', 'plans', '--file', other, '--idempotency-key', 'cve-123', '--json'])
    expect([reused.code, failure(reused).reason]).toEqual([1, 'duplicate_id'])
  }, 60_000)

  it('reads a plan from stdin for -, and prints one JSON document with --json', async () => {
    const plan = JSON.stringify([{ key: 'build', text: 'build a1b2c3' }, { text: 'deploy a1b2c3', needs: [{ key: 'build' }] }])
    const made = await vb(['tasks', 'create', 'piped', '--file', '-', '--json'], {}, plan)
    expect(made).toMatchObject({ code: 0, stderr: '' })
    const { tasks, ...rest } = JSON.parse(made.stdout) as { tasks: MessageView[] }
    expect(rest).toEqual({})
    expect(tasks.map((root) => [root.text, root.channel, root.task?.state, root.task?.needs])).toEqual([
      ['build a1b2c3', 'piped', 'ready', []],
      ['deploy a1b2c3', 'piped', 'waiting', [tasks[0]!.id]],
    ])
  }, 60_000)

  it('refuses what is no plan as misuse, before the board is asked', async () => {
    const misused = async (args: string[], stdin?: string) => {
      const ran = await vb(['tasks', 'create', ...args], {}, stdin)
      expect([ran.code, ran.stdout], args.join(' ')).toEqual([2, ''])
      return ran.stderr.split('\n')[0]
    }
    const plan = await planFile([{ text: 'one task' }])
    expect(await misused(['none', '--file', '/nowhere/plan.json'])).toBe("error: Can't read /nowhere/plan.json. There's no such file.")
    // A file of prose is the likeliest slip, --file carried over from post: it says what --file is here.
    expect(await misused(['none', '--file', await planFile('not json', 'notes.txt')])).toMatch(/^error: \S+notes\.txt isn't JSON: --file on tasks create is a plan of tasks\.$/)
    // With one task's options too, it's still the file that's wrong: the way out is the same command, the file on stdin as its text.
    const notes = await planFile('# fix the flaky test\n\nit fails one run in ten', 'notes.md')
    const prose = await vb(['tasks', 'create', 'prose', '--file', notes, '--label', 'step=fix'])
    expect([prose.code, prose.stdout]).toEqual([2, ''])
    expect(prose.stderr.replaceAll(notes, 'notes.md').split('\n').slice(0, 3)).toEqual([
      "error: notes.md isn't JSON: --file on tasks create is a plan of tasks.",
      '',
      "  One task's text goes on stdin, as -: vb tasks create prose --label step=fix - < notes.md",
    ])
    const piped = await vb(['tasks', 'create', 'prose', '--file', '-', '--label', 'step=fix'], {}, 'fix it')
    expect(piped.stderr.split('\n')[2]).toBe("  One task's text goes on stdin, as -: vb tasks create prose --label step=fix -")
    // That command makes the one task, with the file's text and the label.
    const made = (await ok(['tasks', 'create', 'prose', '--label', 'step=fix', '-'], {}, '# fix the flaky test\n\nit fails one run in ten')).trim()
    expect(await task(made)).toMatchObject({ text: '# fix the flaky test\n\nit fails one run in ten', labels: { step: 'fix' }, task: { state: 'ready' } })
    expect(await misused(['none', '--file', '-'], '{"text": "one task"}')).toBe('error: stdin holds no tasks. A plan is a JSON array of tasks: [{"key": "fix", "text": "…"}, {"text": "…", "needs": [{"key": "fix"}]}].')
    expect(await misused(['none', '--file', await planFile([])])).toMatch(/ holds no tasks\. A plan is a JSON array of tasks/)
    expect(await misused(['none', '--file', await planFile(['a task'])])).toMatch(/ holds no tasks\. A plan is a JSON array of tasks/)
    // What says one task's own text, labels, or needs goes in the file.
    expect(await misused(['none', 'a task of its own', '--file', plan])).toBe("error: Text is one task's: with --file, each task in the file has its own.")
    for (const flag of [['--label', 'step=fix'], ['--needs', '812'], ['--for', 'fixer'], ['--claim'], ['--no-sync']])
      expect(await misused(['none', '--file', plan, ...flag])).toBe(`error: ${flag[0]} is one task's: with --file, each task in the file has its own.`)
    // The options' old names say what they are now, and make nothing.
    expect(await misused(['none', '--tasks-file', plan])).toBe('error: --tasks-file is --file now.')
    expect(await misused(['none', '--text-file', plan])).toBe('error: --text-file is gone from tasks create.')
    // Only where they were: a claim never took either, and a grant's --file is its grants, not a plan.
    const first = async (args: string[]) => (await vb(args)).stderr.split('\n')[0]
    expect(await first(['tasks', 'claim', '1', '--tasks-file', plan])).toBe('error: Unknown option --tasks-file for vb tasks.')
    expect(await first(['tasks', 'claim', '1', '--text-file', plan])).toBe('error: Unknown option --text-file for vb tasks.')
    expect(await first(['grants', 'create', '--tasks-file', plan])).toBe('error: Unknown option --tasks-file for vb grants.')
    expect(await first(['grants', 'create', '--text-file', plan])).toBe('error: Unknown option --text-file for vb grants.')
    const thread = await create('elsewhere', 'a thread that is there')
    expect(await misused([thread, '--file', plan])).toBe(`error: --file holds a plan, which starts threads in a channel, and #${thread} is a thread.`)
    expect(await ok(['channels'])).not.toMatch(/^none\b/m)
    // What the board refuses of a plan is said by what the command was doing, with its words under it.
    const cycle = await planFile([{ key: 'a', text: 'a', needs: [{ key: 'b' }] }, { key: 'b', text: 'b', needs: [{ key: 'a' }] }])
    const refused = await vb(['tasks', 'create', 'none', '--file', cycle])
    expect(refused).toMatchObject({ code: 2, stdout: '' })
    expect(refused.stderr.split('\n').slice(0, 2)).toEqual(["error: Can't create tasks in none. A task's needs are tasks you can read, or keys of the plan's own.", '  needs: the tasks with the keys "a", "b" wait for each other'])
  }, 60_000)

  it('takes no more tasks under the key of a plan that finished, and names no command that would end the same way', async () => {
    // Two full writes: the plan ends where the second one does.
    const full = Array.from({ length: 200 }, (_, n) => ({ text: `task ${n}` }))
    const path = await planFile(full, 'full.json')
    const made = rows(await ok(['tasks', 'create', 'full', '--file', path, '--idempotency-key', 'full-1']))
    expect(made).toHaveLength(200)
    const grown = await planFile([...full, { text: 'one more' }], 'grown.json')
    const refused = await vb(['tasks', 'create', 'full', '--file', grown, '--idempotency-key', 'full-1'])
    expect(refused).toMatchObject({ code: 1, stdout: '' })
    const lines = refused.stderr.split('\n')
    // The board's words under what the command was doing, and what to do in place of the same command again.
    expect([lines[0], ...lines.slice(2)]).toEqual([
      "error: Can't create tasks in full. That key made another plan.",
      '',
      '  Leave what the key made as it was, or make new tasks under another key',
      '',
    ])
    expect(rows(await ok(['tasks', 'full', '--limit', '500']))).toEqual(made)
    const document = failure(await vb(['tasks', 'create', 'full', '--file', grown, '--idempotency-key', 'full-1', '--json'])) as ReturnType<typeof failure> & { hint?: string }
    expect(document).toMatchObject({ reason: 'duplicate_id', hint: 'Leave what the key made as it was, or make new tasks under another key' })
    expect(document.next).toBeUndefined()
    // The file it was made from is still the plan: its tasks, as they are, and none more.
    expect(rows(await ok(['tasks', 'create', 'full', '--file', path, '--idempotency-key', 'full-1']))).toEqual(made)
    expect(rows(await ok(['tasks', 'full', '--limit', '500']))).toHaveLength(200)
  }, 60_000)

  it('refuses a key no task takes, and a need that is neither an ID nor a key, before anything is made', async () => {
    const refused = async (plan: unknown, extra: NodeJS.ProcessEnv = {}) => {
      const path = await planFile(plan)
      const ran = await vb(['tasks', 'create', 'typos', '--file', path], extra)
      expect([ran.code, ran.stdout], JSON.stringify(plan)).toEqual([2, ''])
      return ran.stderr.replaceAll(path, 'plan.json').split('\n')
    }
    // A key an edit away from one a task takes is said with that one, and with the task it's on.
    expect(await refused([{ key: 'fix', text: 'fix it' }, { text: 'review it', need: [{ key: 'fix' }] }])).toEqual(['error: Unknown key "need" on task 2 of plan.json. Did you mean "needs"?', '', '  See what a plan takes:', '    vb tasks create --help', ''])
    expect((await refused([{ text: 'fix it', label: { step: 'fix' } }]))[0]).toBe('error: Unknown key "label" on task 1 of plan.json. Did you mean "labels"?')
    expect((await refused([{ text: 'fix it' }, { text: 'review it' }, { text: 'ship it', 'no-sync': true }]))[0]).toBe('error: Unknown key "no-sync" on task 3 of plan.json. Did you mean "noSync"?')
    expect((await refused([{ text: 'fix it', Needs: [] }]))[0]).toBe('error: Unknown key "Needs" on task 1 of plan.json. Did you mean "needs"?')
    // One that's near none is said with what a task takes.
    expect((await refused([{ text: 'fix it', weight: 'high' }])).slice(0, 2)).toEqual(['error: Unknown key "weight" on task 1 of plan.json.', '  a task takes key, text, labels, needs, for, priority, noSync, attachments'])
    // What a task waits for is a list, each a task's ID or a key of the plan's own.
    expect((await refused([{ key: 'fix', text: 'fix it' }, { text: 'review it', needs: [{ key: 'fix' }, { ref: 'fix' }] }]))[0]).toBe('error: Task 2 of plan.json needs {"ref":"fix"}. A need is a key of the plan\'s own, like "fix" or {"key": "fix"}, or a task\'s ID as vb prints it or as {"id": "…"}.')
    for (const odd of [true, null, ['812'], { id: 812 }, { id: '' }, { id: '812', key: 'fix' }, { key: 'fix', text: 'fix it' }, { key: 5 }, '', '#', 1.5])
      expect((await refused([{ text: 'review it', needs: ['812', odd] }]))[0]).toBe(`error: Task 1 of plan.json needs ${JSON.stringify(odd)}. A need is a key of the plan's own, like "fix" or {"key": "fix"}, or a task's ID as vb prints it or as {"id": "…"}.`)
    expect((await refused([{ text: 'review it', needs: [{ task: 'a'.repeat(100) }] }]))[0]).toBe(`error: Task 1 of plan.json needs {"task":"${'a'.repeat(50)}…. A need is a key of the plan's own, like "fix" or {"key": "fix"}, or a task's ID as vb prints it or as {"id": "…"}.`)
    expect((await refused([{ text: 'review it', needs: '812' }]))[0]).toBe('error: Task 1 of plan.json has needs that aren\'t a list, such as [{"key": "fix"}, "812"].')
    // From stdin, and for a program: the same, as one document.
    const piped = await vb(['tasks', 'create', 'typos', '--file', '-', '--json'], {}, JSON.stringify([{ text: 'fix it', labls: { step: 'fix' } }]))
    expect([piped.code, piped.stdout]).toEqual([2, ''])
    expect(failure(piped)).toMatchObject({ reason: 'invalid_arguments', message: 'Unknown key "labls" on task 1 of stdin. Did you mean "labels"?', next: [{ argv: ['vb', 'tasks', 'create', '--help'] }] })
    // Nothing was sent: no task before the one refused was made, so the channel isn't there, and a board that can't be reached isn't asked.
    expect(await ok(['channels'])).not.toMatch(/^typos\b/m)
    expect((await refused([{ text: 'fix it', for: 'fixer', need: [] }], { BOARD_URL: 'http://127.0.0.1:1/api/board' }))[0]).toBe('error: Unknown key "need" on task 1 of plan.json. Did you mean "needs"?')
    // Every key a task does take goes through.
    const whole = await planFile([{ key: 'fix', text: 'fix it', labels: { step: 'fix' }, needs: [], for: 'fixer', noSync: true, attachments: [] }, { text: 'review it', needs: [{ key: 'fix' }] }])
    expect(rows(await ok(['tasks', 'create', 'typos', '--file', whole])).map((row) => row.replace(/\s+/g, ' ').split(' ').slice(1, 2))).toEqual([['ready'], ['waiting']])
  }, 60_000)

  it("says what to do with a task's text the board won't take, and makes none of its batch", async () => {
    const path = await planFile([{ text: 'fix CVE-123 in acme/web' }, { text: 'x'.repeat(10_001) }], 'long.json')
    const refused = await vb(['tasks', 'create', 'long', '--file', path])
    expect(refused).toEqual({
      code: 1,
      stdout: '',
      stderr: "error: Can't create tasks in long. A message's text is at most 10,000 characters.\n\n  Keep it short, and reply to the task with the long part in a file with --attach\n",
    })
    expect(failure(await vb(['tasks', 'create', 'long', '--file', path, '--json'])).reason).toBe('payload_too_large')
    expect(await ok(['channels'])).not.toMatch(/^long\b/m)
  }, 60_000)

  it('says what a plan that stopped midway made, and the command that makes the rest under the same key', async () => {
    // 120 steps, each after the one before: more than one write holds. The 111th also waits for a task that isn't there.
    const steps = Array.from({ length: 120 }, (_, n) => ({ key: `step-${n}`, text: `migrate shard ${n}`, ...(n > 0 ? { needs: [{ key: `step-${n - 1}` }] } : {}) }))
    const broken = await planFile(steps.map((step, n) => (n === 110 ? { ...step, needs: [...step.needs!, '999999'] } : step)), 'shards.json')
    const stopped = await vb(['tasks', 'create', 'shards', '--file', broken])
    expect(stopped).toMatchObject({ code: 2, stdout: '' })
    const made = rows(await ok(['tasks', 'shards', '--state', 'all', '--limit', '500'])).map(idOf)
    expect(made).toHaveLength(100)
    const lines = stopped.stderr.split('\n')
    const key = /--idempotency-key (\S+)$/.exec(lines[5]!)?.[1]
    expect(key).toMatch(/^[0-9a-f-]{36}$/)
    expect(lines).toEqual([
      "error: Can't create tasks in shards. A task's needs are tasks you can read, or keys of the plan's own.",
      "  needs: #999999 isn't a task",
      `  made 100 of 120: #${made[0]} to #${made[99]}`,
      '',
      '  Make the rest, under the same key: what was made stays as it is:',
      `    vb tasks create shards --file ${broken} --idempotency-key ${key}`,
      '',
    ])
    // The same file under that key stops at the same task, and makes nothing more.
    const again = await vb(['tasks', 'create', 'shards', '--file', broken, '--idempotency-key', key!])
    expect(again.stderr.split('\n').slice(2, 6)).toEqual([lines[2], '', lines[4], lines[5]])
    expect(rows(await ok(['tasks', 'shards', '--state', 'all', '--limit', '500']))).toHaveLength(100)
    // Fixed, and a step longer, the command it named makes the rest: the first hundred stay the tasks they were.
    const fixed = await planFile([...steps, { text: 'check the shards', needs: [{ key: 'step-119' }] }], 'shards.json')
    const finished = await vb(['tasks', 'create', 'shards', '--file', fixed, '--idempotency-key', key!])
    expect(finished).toMatchObject({ code: 0, stderr: '' })
    expect(rows(finished.stdout).map(idOf).slice(0, 100)).toEqual(made)
    expect(rows(finished.stdout)).toHaveLength(121)
    expect(rows(await ok(['tasks', 'shards', '--state', 'all', '--limit', '500']))).toHaveLength(121)
    // For a program: the failure as one document, with what was made and the command in it.
    const json = await vb(['tasks', 'create', 'shards-again', '--file', broken, '--idempotency-key', 'shards-again-1', '--json'])
    expect(json).toMatchObject({ code: 2, stdout: '' })
    const document = failure(json) as ReturnType<typeof failure> & { data: { created: string[]; total: number; error: { code: string } } }
    expect(document).toMatchObject({ reason: 'invalid_needs', data: { total: 120, error: { code: 'invalid_needs', status: 400 } } })
    expect(document.data.created).toHaveLength(100)
    expect(document.next).toEqual([expect.objectContaining({ argv: ['vb', 'tasks', 'create', 'shards-again', '--file', broken, '--json', '--idempotency-key', 'shards-again-1'] })])
    // A plan whose first write is refused made nothing: it says so by saying nothing of what was made.
    const first = await planFile([{ text: 'waits for nothing there', needs: ['999999'] }])
    const none = await vb(['tasks', 'create', 'nothing', '--file', first])
    expect(none.stderr).toBe("error: Can't create tasks in nothing. A task's needs are tasks you can read, or keys of the plan's own.\n  needs: #999999 isn't a task\n\n  See the tasks there are:\n    vb tasks --state all\n")
  }, 120_000)
})
