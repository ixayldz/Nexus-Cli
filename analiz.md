Kısa Hüküm
PRD’de tarif edilen v1/prod-ready ürün hedeflerine göre Nexus CLI şu an yaklaşık %40 prod-ready.
Ama local release mühendisliği açısından durum daha iyi: %80-85 release-candidate hijyeni var. Yani paketlenir, testleri geçer, CLI çalışır; fakat PRD’deki “gerçek agentic SDLC runtime + öğrenen güvenli Codex-benzeri
ürün” seviyesine henüz gelmemiş.

Doğrulama
Çalıştırdığım kapılar geçti:

- pnpm verify:release geçti.
- pnpm verify:external geçti: DeepSeek call + stream smoke başarılı.
- pnpm audit --audit-level high: bilinen high vulnerability yok.
- Testler: 24 dosya / 112 test passed
- Coverage: statements 72.47%, branches 57.68%, functions 74.48%, lines 73.68%

Tracked git state bende değişmedi; sadece mevcut durumda architecture.md ve implementation.md silinmiş görünüyor.

Tamam Olanlar

- Monorepo yapısı, build/typecheck/lint/test/coverage/release gate iyi kurulmuş.
- CLI binary/package hedefi var: @ixayldz/nexus-cli, nexus.
- exec, --json, artifact çıktıları, exit code mapping, temp smoke testlerde çalışıyor.
- DeepSeek ve OpenAI provider adapter var; DeepSeek canlı smoke geçti.
- Tool Bus mevcut: file read/write, patch, shell, git, test, search, MCP call.
- Event stream, session manifest, .nexus/runs, JSONL logging var.
- Config hiyerarşisi var: system/user/project/explicit/profile/override.
- Sandbox/approval policy motoru var; protected path, risk scoring, non-interactive approval exit 2 davranışı çalışıyor.
- SDLC komutları mevcut: /goal, /plan, /verify, /review, /ship, /compact, /memories.
- CI/security/release GitHub workflow dosyaları mevcut.

Büyük Eksikler

- Agent katmanı hâlâ minimal. packages/agent/src/index.ts:14 en fazla 3 tool-call iterasyonu yapıyor; gerçek görev yönetimi, sağlam planlama, uzun iş akışı, critic/reviewer ayrımı yok.
- Subagent prod özelliği değil, placeholder. packages/agent/src/index.ts:176 sadece özet string döndürüyor.
- Çok sayıda komut stub/placeholder. apps/cli/src/main.ts:663 ve yardım metninde fork, login/logout için açıkça stub deniyor.
- Sandbox varsayılanı PRD’deki “default-deny/read-only’e yakın” seviyede değil. Config default workspace-write; hard sandbox kapalı. packages/config/src/index.ts:147, packages/sandbox/src/index.ts:60
- “Hard sandbox” yoksa shell komutları host üzerinde soft policy guard ile çalışıyor. Bu private alpha için kabul edilebilir, public prod için zayıf.
- Review fallback çok yüzeysel: büyük diff, secret pattern, test dosyası değişmedi gibi heuristikler. Gerçek semantic review ancak provider JSON döndürürse var. packages/sdlc/src/index.ts:780
- Learning Plane gerçek öğrenme değil; paket yöneticisi, test komutu, touched files gibi deterministik candidate üretiyor. active mode bile suggest’e düşürülüyor. packages/learning/src/index.ts:84, packages/learning/
  src/index.ts:622
- Prompt injection detection sadece AGENTS.md üzerinde ve 3 phrase ile sınırlı. Tool output, README, MCP/web content kapsamı PRD’ye göre eksik. packages/context/src/index.ts:101, packages/security/src/index.ts:548
- MCP registry var ama prod MCP platformu değil: feature off default, stdio execution ağırlıklı, manifest/governance/remote registry eksik. packages/tool-bus/src/index.ts:1088
- Session resume gerçek context replay değil; manifest üzerinden session açıyor, ama conversation state/SDLC/learning transcript replay sınırlı. packages/runtime/src/index.ts:165
- Windows config bug buldum: PowerShell Set-Content -Encoding UTF8 ile yazılan .nexus/config.toml BOM yüzünden parse edilemiyor. Sebep: config raw okunup direkt TOML parse ediliyor. packages/config/src/index.ts:303

PRD’ye Göre Readiness

- Release engineering / packaging: 85%
- CLI exec + JSONL + artifacts: 65%
- Interactive TUI: 45%
- Tool Bus: 60%
- Security / sandbox / approvals: 45%
- Agentic SDLC Plane: 45%
- Learning Plane: 30-35%
- Model provider layer: 60%
- MCP / skills / hooks / plugins: 25-35%
- Enterprise readiness: 15-20%

Sonuç
Bu repo şu an public v1/prod-ready değil. En doğru sınıflandırma: güçlü bir private-alpha / erken beta adayı. Kod kalitesi ve release gate’leri iyi; ürün davranışı ise PRD’nin iddialı kapsamına göre hâlâ iskelet +
vertical slice seviyesinde.

Prod’a yaklaşmak için önce hard sandbox default profili, gerçek subagent/SDLC orchestration, daha sağlam review-learning-security pipeline, session replay, Windows config BOM fix ve stub komutların gerçek
implementasyonu kapanmalı.
