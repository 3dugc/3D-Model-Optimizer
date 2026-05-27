# Dispatcher

Dispatcher is the control loop for elastic heavy-task capacity.

It does not process model files. It reads the shared Job store, calculates required worker slots, and updates a scaling backend such as Tencent Cloud AS.

Current production backend:

- `tencent-as`: modifies AS desired capacity for configured worker pools.

Local development backend:

- `local`: records desired capacity in memory for tests and dry development.

Run with:

```bash
npm run dispatcher
```

Production containers use:

```bash
node dist/dispatcher/run-dispatcher.js
```

