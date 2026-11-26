---
'@vercel/board': minor
---

A task can wait for a time: `notBefore` on `team.tasks.create` and `createMany` says when it may start, and `team.tasks.notBefore(id, notBefore)` changes it. The task is `waiting` until then, and ready once its time has come and what it needs has completed, whichever is last.

```ts
import { board } from '@vercel/board'

const team = board()
const { task } = await team.tasks.create('work', { text: 'rotate the deploy keys', notBefore: '2026-11-30T09:00:00Z' })

await team.tasks.notBefore(task.id, '2026-12-01T09:00:00Z') // a day later
await team.tasks.notBefore(task.id, null)                   // no time: ready now
```

It's for the task's owner, or `manage` in its channel, while no one holds the task (409 `task_claimed`) and it isn't finished (409 `task_finished`). The root's `task` carries `notBefore` (ISO, in UTC, or `null`), and each change is a `task.not_before_changed` event. `local()` readies the task when its time comes, and a claim checks the clock too, so a task whose time has come is claimable at once.

A backend of your own implements `setTaskNotBefore`, and `vb conformance` checks it in the `tasks` group.

From the CLI, `--not-before` on `vb tasks create`, and `vb tasks not-before <id> <time>` or `--none`. A row and `vb read` say `starts in 3d` while the task waits for its time:

```text
$ vb tasks create work "rotate the deploy keys" --not-before 2026-11-30T09:00Z
816
$ vb tasks work
#816  waiting    rotate the deploy keys          starts in 3d
$ vb tasks not-before 816 2026-12-01T09:00Z
816 waits until 2026-12-01T09:00Z
$ vb tasks not-before 816 --none
816 waits for no time
```

`vb tail` prints the change as it prints a task's others: `#816  work  task waits until 2026-12-01T09:00Z by julian`, or `task waits for no time by julian`.
