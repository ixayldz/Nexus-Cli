# Nexus CLI Kullanim Rehberi

Bu dokuman Nexus CLI'i bu repo icinden local olarak nasil calistiracagini anlatir.

Nexus, terminal uzerinden repo context'ini okuyan, plan cikaran, dosya degistirebilen, test calistirabilen, review yapan, artifact uretebilen ve session/event log tutan agentic coding CLI runtime'dir.

> Not: Bu asamada ana local kullanim `node apps/cli/dist/main.js` uzerindendir. Global `npm install -g` akisina guvenme; once repo icinde build al.

## 1. Gereksinimler

Gerekli:

```powershell
node --version
pnpm --version
```

Beklenen:

- Node.js `22` veya uzeri
- `pnpm`
- Windows PowerShell

Opsiyonel:

- Docker veya Podman: hard sandbox icin
- `DEEPSEEK_API_KEY`: canli DeepSeek provider testi ve gercek model kullanimi icin

## 2. Ilk Kurulum

Repo kok dizininde calis:

```powershell
cd C:\Users\ixayl\Desktop\nexus
pnpm install
pnpm build
node apps/cli/dist/main.js --version
```

Beklenen version ciktisi:

```text
0.0.0
```

Bu normaldir. Paket henuz publish/version release akisina alinmadigi icin local build version `0.0.0` doner.

## 3. En Temel Komutlar

Interactive terminal modunu ac:

```powershell
node apps/cli/dist/main.js
```

Ilk prompt ile interactive baslat:

```powershell
node apps/cli/dist/main.js "Bu repoyu analiz et ve riskleri soyle"
```

TUI acmadan tek seferlik non-interactive calistir:

```powershell
node apps/cli/dist/main.js exec "package.json dosyasini oku ve ozetle"
```

JSONL event stream ile calistir:

```powershell
node apps/cli/dist/main.js exec --json "package.json dosyasini oku ve ozetle"
```

Baska bir klasoru runtime working directory olarak kullan:

```powershell
node apps/cli/dist/main.js exec --cd C:\path\to\project "Bu projeyi analiz et"
```

Yardim metni:

```powershell
node apps/cli/dist/main.js --help
```

## 4. DeepSeek Ile Canli Model Kullanimi

Bu projede ana canli provider olarak DeepSeek kullanilacak.

PowerShell'de API key set et:

```powershell
$env:DEEPSEEK_API_KEY="deepseek_api_key_buraya"
```

DeepSeek profiliyle basit test:

```powershell
node apps/cli/dist/main.js exec --profile deepseek "Kisaca hello de"
```

Provider smoke test:

```powershell
pnpm provider:smoke
```

Eger API key set edilmemisse su cikti normaldir:

```text
skipped: DEEPSEEK_API_KEY is not set.
```

Bu hata degil; canli provider testi anahtar olmadigi icin atlanmis demektir.

## 5. Interactive Modda Slash Komutlari

Interactive moddayken komutlari prompt satirina yazarsin.

Durum goster:

```text
/status
```

SDLC hedefi belirle:

```text
/goal Failing testleri minimal diff ile duzelt
```

Plan uret:

```text
/plan
```

Plan icin ek aciklama ver:

```text
/plan Once testleri incele, sonra minimal patch uygula
```

Dogrulama calistir:

```text
/verify pnpm test
```

Mevcut degisiklikleri review et:

```text
/review
```

Ship/release gate ozetini uret:

```text
/ship
```

Context compact ve memory candidate uret:

```text
/compact
```

Memory durumunu goster:

```text
/memories
```

Tum pending memory candidate'lari kabul et:

```text
/memories accept
```

Memory audit ozeti:

```text
/memories audit
```

Memory export JSON:

```text
/memories export
```

MCP durumunu goster:

```text
/mcp
```

Skills durumunu goster:

```text
/skills
```

Hooks durumunu goster:

```text
/hooks
```

Pending approval'lari goster:

```text
/approvals
```

Son approval istegini onayla:

```text
/approve
```

Son approval istegini session boyunca onayla:

```text
/approve-session
```

Son approval istegini reddet:

```text
/deny
```

Rollback calistir:

```text
/rollback latest
```

Oturumu kapat:

```text
/quit
```

## 6. Onerilen Interactive Coding Akisi

Gunluk kod degisikligi icin onerilen akis:

```text
/goal Failing testleri minimal diff ile duzelt
/plan
```

Sonra dogal dilde istegi ver:

```text
Plan uygunsa degisikligi yap, gereksiz refactor yapma.
```

Ardindan:

```text
/verify pnpm test
/review
/ship
/compact
/memories
```

Eger memory candidate mantikliysa:

```text
/memories accept
```

Bu akis PRD'deki Agentic SDLC Plane'e denk gelir:

```text
discover -> plan -> implement -> verify -> review -> ship -> learn
```

## 7. Non-Interactive Artifact Uretimi

CI, script veya otomasyon icin `exec` kullan.

Final cevap dosyasi uret:

```powershell
node apps/cli/dist/main.js exec `
  --output artifacts\final.md `
  "Bu repoyu analiz et ve kisa ozet yaz"
```

Patch, verification report ve event log uret:

```powershell
node apps/cli/dist/main.js exec `
  --json `
  --output artifacts\final.md `
  --patch artifacts\diff.patch `
  --report artifacts\verification.json `
  --events artifacts\events.jsonl `
  "package.json dosyasini oku ve ozetle"
```

Review report ve learning candidate artifact'i de al:

```powershell
node apps/cli/dist/main.js exec `
  --json `
  --review-report artifacts\review.json `
  --learning-candidates artifacts\learning.json `
  "Mevcut diff'i review et"
```

Verification komutu calistir:

```powershell
node apps/cli/dist/main.js exec `
  --verify "pnpm test" `
  "Degisiklikleri kontrol et"
```

Verification fail olursa rollback dene:

```powershell
node apps/cli/dist/main.js exec `
  --verify "pnpm test" `
  --rollback-on-verify-fail `
  "Fikleri uygula ve testleri calistir"
```

## 8. Exit Code Anlamlari

Non-interactive modda cikis kodlari onemlidir:

| Kod | Anlam |
|---:|---|
| 0 | Basarili |
| 1 | Genel hata |
| 2 | Approval gerekli ama ortam non-interactive |
| 3 | Sandbox hatasi veya sandbox unavailable |
| 4 | Model/provider hatasi |
| 5 | Tool/security/network hatasi |
| 6 | Verification failed |
| 7 | Config hatasi |
| 8 | Auth hatasi |

PowerShell'de son exit code:

```powershell
$LASTEXITCODE
```

## 9. Sandbox ve Guvenlik

Sandbox modunu CLI'dan override edebilirsin:

```powershell
node apps/cli/dist/main.js exec --sandbox read-only "Sadece analiz yap"
```

Workspace icinde yazma izni:

```powershell
node apps/cli/dist/main.js exec --sandbox workspace-write "Minimal patch uygula"
```

Sandbox doctor:

```powershell
node apps/cli/dist/main.js sandbox doctor
```

Beklenen ornek cikti:

```text
Sandbox doctor
Platform: win32
Hard sandbox available: docker
- typescript: available, soft
- docker: available, hard
- podman: missing, soft
```

Hard sandbox config'te zorunluysa ve Docker/Podman yoksa Nexus fail-closed davranir. Yani calistirmak yerine guvenli sekilde durur.

Protected path ornekleri:

```text
.env
.env.*
.ssh
.aws
.gcp
.azure
.git
node_modules
dist
build
```

Riskli shell komutlari policy ve approval'a takilir. Ornek:

```text
rm -rf
curl | bash
cat .env
printenv
git push --force
npm publish
kubectl
aws
gcloud
az
```

## 10. Approval Kullanimi

Approval policy override:

```powershell
node apps/cli/dist/main.js exec `
  --ask-for-approval never `
  "Sadece guvenli analiz yap"
```

Interactive modda approval geldiginde:

```text
/approvals
/approve
```

Session boyunca onaylamak icin:

```text
/approve-session
```

Reddetmek icin:

```text
/deny
```

Non-interactive modda approval gerekiyorsa CLI durur ve exit code genellikle `2` olur.

## 11. MCP Kullanimi

MCP server listesini goster:

```powershell
node apps/cli/dist/main.js mcp
```

Local stdio MCP server ekle:

```powershell
node apps/cli/dist/main.js mcp add local node server.js
```

Yeni eklenen MCP server varsayilan olarak `untrusted` olur.

Server'i trusted yap:

```powershell
node apps/cli/dist/main.js mcp trust local
```

Belirli tool'a izin ver:

```powershell
node apps/cli/dist/main.js mcp allow-tool local search
```

Tool iznini kaldir:

```powershell
node apps/cli/dist/main.js mcp deny-tool local search
```

Server'i disable et:

```powershell
node apps/cli/dist/main.js mcp disable local
```

Server'i tekrar enable et:

```powershell
node apps/cli/dist/main.js mcp enable local
```

Server'i sil:

```powershell
node apps/cli/dist/main.js mcp remove local
```

MCP execution icin ayrica config policy tarafinda `features.mcp` ve `allowed_mcp_servers` ayarlarinin uygun olmasi gerekir.

## 12. Config Dosyasi

Project config yolu:

```text
.nexus/config.toml
```

Basit DeepSeek project config ornegi:

```toml
model_provider = "deepseek"
model = "deepseek-v4-flash"

[sdlc]
require_plan_for_large_changes = true
require_verification = true
require_review_for_security_sensitive_changes = true

[security]
network_default = "off"
require_hard_sandbox = false

[policy]
allowed_providers = ["deepseek"]
allowed_models = ["deepseek-v4-flash"]

[telemetry]
enterprise_audit = true
content_telemetry = false
```

Config kaynaklarini debug et:

```text
/debug-config
```

Explicit config ile calistir:

```powershell
node apps/cli/dist/main.js exec `
  --config .nexus\config.toml `
  "Bu config ile analiz yap"
```

## 13. Dogrulama ve Release Komutlari

Kod kalitesini kontrol et:

```powershell
pnpm lint
pnpm typecheck
pnpm test
```

Eval komutlari:

```powershell
pnpm eval:baseline
pnpm eval:security
pnpm provider:smoke
```

Package/release kontrolleri:

```powershell
pnpm verify:package
pnpm verify:release
```

`verify:release` zinciri sunlari calistirir:

```text
build
test
lint
typecheck
eval:baseline
eval:security
provider:smoke
verify:package
release-verify
```

## 14. Ilk Deneme Senaryosu

Temiz ilk deneme icin:

```powershell
cd C:\Users\ixayl\Desktop\nexus
pnpm install
pnpm build
node apps/cli/dist/main.js --version
node apps/cli/dist/main.js exec "package.json dosyasini oku ve ozetle"
node apps/cli/dist/main.js sandbox doctor
pnpm verify:release
```

DeepSeek ile canli deneme:

```powershell
$env:DEEPSEEK_API_KEY="deepseek_api_key_buraya"
pnpm provider:smoke
node apps/cli/dist/main.js exec --profile deepseek "Bu repoyu kisaca analiz et"
```

## 15. Sik Karsilasilan Durumlar

### `--version` sadece `0.0.0` donuyor

Normal. Local workspace version henuz release/publish akisina alinmamis.

### `DEEPSEEK_API_KEY is not set`

Canli DeepSeek key yok. PowerShell'de set et:

```powershell
$env:DEEPSEEK_API_KEY="deepseek_api_key_buraya"
```

### Degisiklikler bekledigim gibi gorunmuyor

Once build al:

```powershell
pnpm build
```

Sonra CLI'i dist uzerinden calistir:

```powershell
node apps/cli/dist/main.js --help
```

### Hard sandbox calismiyor

Doctor calistir:

```powershell
node apps/cli/dist/main.js sandbox doctor
```

Docker veya Podman yoksa hard sandbox gerektiren policy fail-closed olur.

### Non-interactive komut approval istedi ve durdu

Bu beklenen guvenlik davranisidir. Interactive modda calistirip `/approve` kullan veya policy/config ayarlarini kontrollu sekilde degistir.

### `npm ile yuklenmiyor mu?`

Su an bu repo icinde local development akisi `pnpm install` ve `pnpm build` uzerindendir. CLI'i local olarak su sekilde calistir:

```powershell
node apps/cli/dist/main.js
```

Package dry-run icin:

```powershell
pnpm verify:package
```

Bu komut npm pack dry-run kontrolunu release safety gate icinde calistirir.

