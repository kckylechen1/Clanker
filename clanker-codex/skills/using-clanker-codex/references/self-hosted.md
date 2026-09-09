# Self-hosted inference

The agent and its tools run on the local host. Only inference requests go to the DGX endpoint. This plugin does not execute code on the DGX, pool GPU memory, deploy models, or provide a cluster scheduler.

Configure each deployed endpoint as a distinct OpenCode provider. For an OpenAI-compatible Chat Completions endpoint, OpenCode's official configuration uses `@ai-sdk/openai-compatible`, `options.baseURL`, and a `models` mapping. Use the actual served model ID, tool-calling support and context limits advertised by the deployed server. Do not infer these from a model name.

An illustrative fragment (not installed or enabled by this plugin):

```json
{
  "provider": {
    "dgx-a": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DGX Spark A",
      "options": { "baseURL": "https://spark-a.example.invalid/v1" },
      "models": { "served-model-id": { "name": "Local coding model" } }
    },
    "dgx-b": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "DGX Spark B",
      "options": { "baseURL": "https://spark-b.example.invalid/v1" },
      "models": { "served-model-id": { "name": "Local review model" } }
    }
  }
}
```

Replace example endpoints and IDs after deployment. Merge provider entries into the existing OpenCode configuration; do not overwrite the user's configuration. Where authentication is required, use OpenCode's `/connect` custom-provider flow with the matching provider ID. Do not embed an API key in this document or in Clanker configuration.

Before dispatch, run `opencode models --pure`, or use `clanker_models(provider="dgx-a")`. Then run a bounded read-only task on `dgx-a/served-model-id` that requires a file/tool round-trip. A configured catalog entry alone does not prove compatibility. Verify the requested and observed model and the actual result. Repeat separately for DGX B. Failures must stay on their chosen route; do not fall back to paid cloud inference automatically.

Official provider and configuration reference: https://opencode.ai/docs/providers/#custom-provider

No private endpoints are seeded now because the user's models are not deployed yet. The arbitrary provider/model route is exercised by automated spawn-contract tests; real DGX inference remains untested until endpoints exist.
