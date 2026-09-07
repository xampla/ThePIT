# pit-nova

Runs the [Nova](https://github.com/Nova-Hunting/nova-framework) rule engine as a small HTTP
service so the Node collector can scan prompts, completions and tool output against the
[nova-rules](https://github.com/Nova-Hunting/nova-rules) set (prompt injection, jailbreaks,
data exfiltration, agentic misuse). Both projects are MIT licensed.

```sh
./setup.sh            # clones nova-rules into ./rules and installs deps with uv
npm run nova          # from the repo root; listens on 127.0.0.1:8765
```

Then enable Nova in The PIT UI (Settings → Rules) and point it at the service URL.

Only keyword and semantic matchers run by default: they are free and offline. The first
start downloads the `all-MiniLM-L6-v2` embedding model (~90 MB). Set `NOVA_SEMANTIC=0`
for keywords only, or `NOVA_LLM=ollama` (plus `OLLAMA_HOST`) to also run the rules that
need an LLM judge without paying for an API. `NOVA_LLM=openai|anthropic|...` with the
matching API key env var works too but costs one call per LLM pattern per unseen text.
