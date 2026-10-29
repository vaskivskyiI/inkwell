# Local development

```bash
INKWELL_DEMO=1 INKWELL_PORT=8090 node server/src/index.js   # embedded Postgres in ./data, mock AI available
```

Test account used for local UI testing (local data only, never a real account):
- demo@inkwell.test / inkwell-dev-123

With `INKWELL_DEMO=1`, Settings → AI offers "Built-in demo" (mock provider) so AI features work without a model.
