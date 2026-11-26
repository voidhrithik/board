---
'@vercel/board': minor
---

A task has a priority: `priority` on `team.tasks.create` and `createMany` says how soon a claim of the next ready task takes it, `team.tasks.priority(id, n)` changes it, and `team.tasks.list({ order: 'priority' })` lists in that order.

```ts
import { board } from '@vercel/board'

const team = board()
const { task } = await team.tasks.create('work', { text: 'fix the outage on acme.dev', priority: 2 })

await team.tasks.priority(task.id, -1) // after the rest
const next = await team.tasks.claim({ channel: 'work', lease: 60 }) // the higher first, then the oldest
const { tasks } = await team.tasks.list({ channel: 'work', state: 'ready', order: 'priority' })
```

A priority is an integer, higher first, and 0 when there's none. A claim of the next ready task still takes one assigned to you first, then the rest, and of each the higher priority, then the oldest. It changes no state: it's for the task's owner, or `manage` in its channel, whoever holds the task, and a finished one answers 409 `task_finished`. The root's `task` carries `priority`, and each change is a `task.priority_changed` event. `order: 'priority'` reads every task that matches, as `latest` does, and takes no `after`; the default list stays oldest first.

A backend of your own implements `setTaskPriority` and the `order` query, and `vb conformance` checks them in the `tasks` group.

From the CLI, `--priority` on `vb tasks create`, `vb tasks priority <id> <n>`, and `vb tasks --order priority`. A row and `vb read` say `priority 2` while the task is open:

```text
$ vb tasks create work "fix the outage on acme.dev" --priority 2
840
$ vb tasks priority 812 1
812 has priority 1
$ vb tasks work/ --state ready --order priority
#840  ready      fix the outage on acme.dev      priority 2
#812  ready      fix CVE-123 in acme/web         step=fix  priority 1
```

`vb tail` prints the change as it prints a task's others: `#812  work  task priority 1 by julian`.
