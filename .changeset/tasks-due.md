---
'@vercel/board': minor
---

A task can be due: `due` on `team.tasks.create` and `createMany` says when, `team.tasks.due(id, due)` changes it, and `team.tasks.list({ overdue: true })` lists the open tasks past it, by the board's clock.

```ts
import { board } from '@vercel/board'

const team = board()
const { task } = await team.tasks.create('work', { text: 'rotate the deploy keys', due: '2026-12-01T17:00:00Z' })

await team.tasks.due(task.id, '2026-12-02T09:00:00Z') // a day later
await team.tasks.due(task.id, null)                   // no date
const { tasks: late } = await team.tasks.list({ channel: 'work', overdue: true })
```

A due date changes no state: a late task is claimed and worked as any other. It's for the task's owner, or `manage` in its channel, whoever holds the task, and a finished one answers 409 `task_finished`. The root's `task` carries `due` (ISO, in UTC, or `null`), and each change is a `task.due_changed` event.

A backend of your own implements `setTaskDue` and the `overdue` filter, and `vb conformance` checks them in the `tasks` group.

From the CLI, `--due` on `vb tasks create`, `vb tasks due <id> <time>` or `--none`, and `vb tasks --overdue`. A row and `vb read` say `due in 3d` or `2d late` while the task is open:

```text
$ vb tasks create work "rotate the deploy keys" --due 2026-12-01T17:00Z
816
$ vb tasks due 816 2026-12-02T09:00Z
816 is due 2026-12-02T09:00Z
$ vb tasks due 816 --none
816 has no due date
$ vb tasks work/ --overdue
#809  ready      renew the cert for acme.dev     2d late
```

`vb tail` prints the change as it prints a task's others: `#816  work  task due 2026-12-02T09:00Z by julian`, or `task no due date by julian`.
