# Nexus CLI Product Requirements Document

**Product Name:** Nexus CLI  
**Platform Name:** Nexus Weaver  
**Document Type:** Product Requirements Document  
**Status:** Draft v1.0  
**Primary Objective:** Codex-style terminal coding agent UX üzerine Agentic SDLC Plane ve Learning Plane ekleyen, local-first, güvenli, model-agnostic bir CLI development runtime inşa etmek.

---

## 1. Executive Summary

Nexus CLI, terminalde çalışan agentic software development runtime’ıdır. Kullanıcı deneyimi bilinçli olarak mevcut piyasa standardına hizalanacaktır: kullanıcı `codex` yerine `nexus` yazacak, aynı TUI mantığını, aynı slash komut kültürünü, aynı approval/sandbox dilini ve aynı interactive/non-interactive çalışma akışını kullanacaktır.

Nexus’un farklılaşması görünürdeki CLI kullanımında değil, arka plandaki runtime mimarisinde olacaktır. Nexus, sıradan bir “terminal chatbot” olmayacaktır. Ürünün çekirdeği; güvenli tool execution, sandbox, approval policy, repo context engine, subagent orchestration, verification, rollback, scoped memory, workflow learning, event logging ve SDLC-aware execution katmanlarından oluşacaktır.

Nexus CLI’ın ana farkı iki yeni ürün katmanıdır:

1. **Agentic SDLC Plane**  
   Kullanıcının her coding task’ını yazılım geliştirme yaşam döngüsü içinde ele alır: discover, plan, implement, verify, review, ship ve learn. Bu katman kullanıcıya ayrı bir karmaşık arayüz olarak sunulmaz; `/plan`, `/goal`, `/diff`, `/review`, `/status`, `/agent`, `/compact` gibi standart slash komutların arkasında çalışır.

2. **Learning Plane**  
   Nexus’un kullanıcı, proje, takım ve workflow seviyesinde kontrollü öğrenmesini sağlar. Bu model eğitimi değildir. Kodun dışarı aktarılması veya fine-tuning yapılması anlamına gelmez. Learning Plane; repo alışkanlıklarını, test komutlarını, proje kurallarını, kullanıcının çalışma tercihlerini, tekrar eden hata kalıplarını ve başarılı/başarısız agent davranışlarını scope’lu, denetlenebilir ve onaylanabilir memory objelerine dönüştürür.

Nexus CLI’ın temel ürün prensibi şudur:

> **Codex gibi kullan. Nexus gibi öğren. SDLC gibi yönet.**

---

## 2. Problem Statement

Modern AI coding CLI araçları güçlü modelleri terminale taşımıştır; fakat çoğu araçta hâlâ şu sorunlar vardır:

- Agent davranışı tekil prompt seviyesinde kalır; görevler SDLC aşamalarına ayrılmaz.
- Kod değişikliği, test, review, rollback ve release çıktıları birbirinden kopuktur.
- Terminal agent’larının hangi tool’u neden çalıştırdığı yeterince görünür değildir.
- Uzun oturumlarda context bozulur, tekrar eden repo bilgileri yeniden anlatılır.
- Memory ya yoktur ya da scope, güvenlik ve onay modeli zayıftır.
- Shell execution ve dosya yazma izinleri çoğu zaman ya fazla kısıtlayıcıdır ya da fazla risklidir.
- Kurumsal kullanım için policy, audit, model allowlist, MCP allowlist ve retention gereksinimleri yetersizdir.
- Non-interactive kullanımda CI/CD, script ve automation çıktıları deterministik değildir.
- Kullanıcılar her yeni CLI aracı için yeni komut modeli öğrenmek istemez.

Nexus CLI bu sorunları, piyasada oluşmuş terminal-agent kullanım standardını bozmadan çözecektir.

---

## 3. Product Vision

Nexus CLI, geliştiricinin terminalinde çalışan güvenli, öğrenen ve SDLC-aware bir coding runtime olacaktır.

Nexus’un uzun vadeli vizyonu:

- Her repository için çalışma kurallarını, test alışkanlıklarını ve mimari gerçekleri anlayan bir development agent.
- Her kod değişikliğini plan, diff, verification, review ve rollback bağlamında ele alan bir runtime.
- Model bağımsız çalışan, OpenAI, Anthropic, Gemini, Bedrock ve local model sağlayıcılarıyla entegre olabilen bir agentic platform.
- Geliştirici bireysel kullanımından enterprise yönetişime kadar ölçeklenebilen güvenli bir CLI.
- Terminal UX standardını korurken arka planda workflow learning, eval generation ve agent performance scorecard üreten bir sistem.

---

## 4. Product Positioning

Nexus CLI şu kategoriye aittir:

> **Local-first agentic development runtime for terminal-based software engineering.**

Nexus bir IDE eklentisi değildir. Nexus yalnızca bir LLM wrapper değildir. Nexus yalnızca bir chat arayüzü değildir. Nexus, terminal içinde çalışan, repo ile etkileşime giren, güvenli tool execution yapan, context yöneten, kod değiştiren, test çalıştıran, review yapan, öğrenen ve bu süreci event olarak kaydeden bir development runtime’dır.

---

## 5. Target Users

### 5.1 Primary Persona: Senior Developer

**İhtiyaçları:**

- Terminalden ayrılmadan kod analizi, patch, refactor ve test çalıştırmak.
- Agent’ın yaptığı değişiklikleri net görmek.
- Gereksiz dosya değişikliklerinden kaçınmak.
- Minimal diff ve doğru test kapsamı almak.
- Uzun oturumlarda context’in korunmasını sağlamak.

**Başarı kriteri:**

- Developer, Nexus’u günlük terminal workflow’una doğal şekilde ekler.
- Basit görevlerde hız kazanır.
- Karmaşık görevlerde güvenli planlama, test ve review akışı elde eder.

### 5.2 Secondary Persona: Tech Lead

**İhtiyaçları:**

- Takım kurallarını `AGENTS.md` veya proje config’i ile tanımlamak.
- Agent’ın güvenli davranmasını sağlamak.
- Review, verification ve release notu üretimini standartlaştırmak.
- Repo özel çalışma alışkanlıklarını takıma yaymak.

**Başarı kriteri:**

- Nexus, takımın kodlama standartlarını tekrar tekrar anlatmaya gerek bırakmaz.
- PR kalitesi, test kapsamı ve review çıktıları daha tutarlı hale gelir.

### 5.3 Secondary Persona: DevOps / Platform Engineer

**İhtiyaçları:**

- CI/CD içinde non-interactive agent çalıştırmak.
- JSON event stream almak.
- Exit code, patch artifact, verification report ve audit log üretmek.
- Sandbox, network policy, model allowlist ve secrets policy tanımlamak.

**Başarı kriteri:**

- Nexus güvenilir şekilde CI/CD pipeline içinde çalışır.
- Hangi tool’un ne zaman, neden ve hangi yetkiyle çalıştığı denetlenebilir.

### 5.4 Enterprise Admin

**İhtiyaçları:**

- Kullanıcı, proje ve organizasyon bazında policy tanımlamak.
- Model sağlayıcılarını ve MCP server’larını allowlist ile yönetmek.
- Retention, telemetry, audit ve secrets yönetimini kontrol etmek.
- Riskli modları kapatmak veya sadece izole runner’da açmak.

**Başarı kriteri:**

- Nexus kurumsal güvenlik ve uyum gereksinimlerini ihlal etmeden agentic development sağlar.

---

## 6. Product Goals

### 6.1 P0 Goals

- `nexus` komutuyla interactive TUI başlatmak.
- `nexus "<prompt>"` ile ilk prompt verilmiş TUI başlatmak.
- `nexus exec "<prompt>"` ile non-interactive/headless çalışmak.
- Codex-style slash komut mental modelini korumak.
- Local repository context’i okuyup analiz etmek.
- Dosya okuma, patch üretme, dosya yazma ve shell komutu çalıştırma tool’larını desteklemek.
- Sandbox ve approval policy ile güvenli execution sağlamak.
- `/plan`, `/goal`, `/diff`, `/review`, `/status`, `/compact`, `/memories`, `/agent`, `/mcp`, `/permissions` komutlarını desteklemek.
- Agentic SDLC Plane’i task lifecycle’a entegre etmek.
- Learning Plane için scope’lu ve onaylı memory candidate üretmek.
- `AGENTS.md` dosyasını proje talimatı olarak desteklemek.
- `~/.nexus/config.toml` ve `.nexus/config.toml` konfigürasyonlarını desteklemek.
- JSONL event stream üretmek.
- Session resume desteği sağlamak.
- En az bir model provider ile production-grade entegrasyon sağlamak.

### 6.2 P1 Goals

- Subagent desteği.
- MCP server entegrasyonu.
- Skills/plugins/hook sistemi.
- Repo map ve symbol index.
- Test command detection.
- Workflow memory.
- Eval generation.
- Model/tool performance scorecard.
- Multi-provider model router.
- Enterprise policy bundle.
- Audit log viewer.
- Shell command risk classifier.
- Secrets scanner.
- Prompt injection detector.

### 6.3 P2 Goals

- Cloud sync opsiyonu.
- Team memory sharing.
- Organization admin console.
- Remote runner desteği.
- Pull request entegrasyonları.
- Issue tracker entegrasyonları.
- Browser/IDE companion.
- Hosted eval dashboard.
- Multi-agent parallel worktree orchestration.

---

## 7. Non-Goals

Nexus v1 aşağıdakileri hedeflemez:

- IDE’nin yerini tamamen almak.
- Kendi foundation modelini geliştirmek.
- Kullanıcı kodu üzerinde varsayılan olarak model eğitimi yapmak.
- Kontrolsüz otomatik memory yazmak.
- Sandbox veya approval olmadan varsayılan shell execution yapmak.
- Tam otonom, kullanıcı onaysız production deploy yapmak.
- Kurumsal policy’yi bypass eden “her şeyi yap” modunu varsayılan hale getirmek.
- Leaked veya lisanssız üçüncü taraf kaynak kodlarını kopyalamak.
- Sadece benchmark skoruna odaklanan bir model wrapper olmak.

---

## 8. Product Principles

### 8.1 Familiar UX, Stronger Runtime

Kullanıcı deneyimi piyasa standardına benzeyecektir. Kullanıcı yeni komut ailesi öğrenmek zorunda kalmayacaktır. Fark arka plandaki runtime’da olacaktır.

### 8.2 Local-First

Nexus varsayılan olarak yerel repository üzerinde çalışır. Dosya erişimi, shell execution, patch üretimi, session kayıtları ve proje memory’si local-first tasarlanır.

### 8.3 Default-Deny Security

Okuma, yazma, shell ve network yetkileri ayrı ayrı yönetilir. Varsayılan güvenlik modeli read-only ve network-off yaklaşımına yakın olmalıdır.

### 8.4 Explicit Escalation

Agent, daha yüksek yetki gerektiğinde bunu görünür şekilde istemelidir. Approval bir UI detayı değil, policy engine çıktısıdır.

### 8.5 Plan Before Mutation

Nexus, anlamlı kod değişikliklerinden önce plan üretmelidir. Plan kullanıcı tarafından görülebilmeli, değiştirilebilmeli veya reddedilebilmelidir.

### 8.6 Verify Before Final

Kod değişikliği yapılan işlerde Nexus, mümkün olduğunda test, lint, typecheck veya uygun doğrulama komutlarını çalıştırmalıdır.

### 8.7 Review Before Trust

Nexus’un ürettiği diff, final kabulden önce review aşamasından geçebilmelidir. Review ayrı bir agent, ayrı bir model veya aynı agent’ın critic modu ile yapılabilir.

### 8.8 Learn With Consent

Learning Plane, kullanıcı ve proje davranışlarından öğrenebilir; fakat memory yazma varsayılan olarak onaylı ve scope’lu olmalıdır.

### 8.9 Observable by Design

Her agent step’i, tool call, permission decision, file change, shell command, verification result ve learning candidate event olarak kaydedilmelidir.

### 8.10 Model-Agnostic, Model-Aware

Nexus tek bir model sağlayıcısına kilitlenmemelidir. Ancak model seçimi task türüne, latency’ye, cost’a, context ihtiyacına ve güvenlik politikasına göre bilinçli yapılmalıdır.

---

## 9. UX Contract

Nexus CLI’ın kullanıcı sözleşmesi şudur:

```bash
nexus
```

Interactive terminal UI başlatır.

```bash
nexus "Bu repoyu analiz et ve riskli modülleri söyle"
```

İlk prompt ile interactive TUI başlatır.

```bash
nexus exec "CI hatasını analiz et ve minimal patch üret"
```

TUI açmadan non-interactive/headless çalışır.

```bash
nexus exec --json "test failure nedenini bul"
```

JSONL event stream üretir.

```bash
nexus resume
nexus resume --last
```

Önceki session’ı devam ettirir.

```bash
nexus fork
```

Mevcut session’dan yeni branch/thread oluşturur.

```bash
nexus mcp
```

MCP server/tool yönetimi sağlar.

```bash
nexus login
nexus logout
```

Provider/auth oturumunu yönetir.

---

## 10. Interactive Mode Requirements

### 10.1 Command

Interactive mode şu komutla başlamalıdır:

```bash
nexus
```

### 10.2 Prompt Argument

Kullanıcı prompt’u komutla birlikte verebilmelidir:

```bash
nexus "Bu modüldeki memory leak risklerini incele"
```

### 10.3 TUI Layout

TUI şu ana bölgelerden oluşmalıdır:

- Transcript area
- Tool call cards
- Approval prompts
- Diff viewer
- Composer input
- Slash command palette
- Status line
- Background process indicator
- Token/context indicator
- SDLC stage indicator
- Learning mode indicator

### 10.4 Status Line

Status line minimum şu bilgileri göstermelidir:

- Active model
- Sandbox mode
- Approval policy
- Current directory
- Git branch
- Token/context usage
- Active SDLC stage
- Learning mode
- Session id veya kısa session referansı

Örnek:

```text
model: gpt-5.5 | sandbox: workspace-write | approval: on-request | branch: feature/auth | SDLC: Verify | learning: suggest
```

### 10.5 Composer

Composer şunları desteklemelidir:

- Natural language prompt
- Slash command input
- File mention
- Multi-line input
- Paste handling
- Keyboard shortcuts
- Optional Vim mode
- Image/file attachment support, provider izin verdiği ölçüde

---

## 11. Non-Interactive Mode Requirements

### 11.1 Definition

Non-interactive mode, TUI açmadan çalışan headless/script modudur. Bu mod internetsiz çalışma anlamına gelmez. CI/CD, automation, cron job, GitHub Actions, local scripts ve pipeline entegrasyonları için tasarlanır.

### 11.2 Command

```bash
nexus exec "<prompt>"
```

### 11.3 JSON Output

```bash
nexus exec --json "<prompt>"
```

JSONL event stream üretmelidir.

### 11.4 Exit Codes

Nexus exec deterministik exit code üretmelidir:

| Exit Code | Meaning                                       |
| --------: | --------------------------------------------- |
|         0 | Task completed successfully                   |
|         1 | Task failed                                   |
|         2 | User/policy approval required but unavailable |
|         3 | Sandbox violation                             |
|         4 | Model/provider error                          |
|         5 | Tool execution error                          |
|         6 | Verification failed                           |
|         7 | Invalid config                                |
|         8 | Authentication error                          |

### 11.5 Artifact Output

Non-interactive mode şu artifact’leri üretebilmelidir:

- Final answer
- Patch file
- Diff summary
- Verification report
- Event log
- Session manifest
- Learning candidates
- Review report

Örnek:

```bash
nexus exec "failing testleri düzelt" \
  --json \
  --output final.md \
  --patch out.patch \
  --report verification.json
```

### 11.6 Approval Behavior

Non-interactive mode’da approval davranışı açıkça tanımlanmalıdır:

```bash
nexus exec --ask-for-approval never "..."
nexus exec --ask-for-approval on-request "..."
```

Approval gerekiyorsa fakat ortam interactive değilse Nexus uygun exit code ile durmalıdır.

---

## 12. Slash Commands

Nexus, Codex-style slash command standardını korumalıdır.

### 12.1 Core Session Commands

| Command         | Requirement                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `/model`        | Aktif modeli değiştirmeli veya model seçiciyi açmalı                    |
| `/fast`         | Hızlı/düşük maliyetli modele geçmeli                                    |
| `/permissions`  | Sandbox ve approval ayarlarını göstermeli/değiştirmeli                  |
| `/approve`      | Son istenen tool/command onayını yönetmeli                              |
| `/status`       | Session, model, sandbox, approval, SDLC ve learning durumunu göstermeli |
| `/debug-config` | Etkin config kaynaklarını ve override zincirini göstermeli              |
| `/statusline`   | Footer/status line alanlarını yapılandırmalı                            |
| `/theme`        | TUI theme ayarlarını yönetmeli                                          |
| `/raw`          | Raw transcript/event görünümünü açmalı                                  |
| `/copy`         | Son cevap veya seçili çıktıyı panoya kopyalamalı                        |
| `/quit`         | Oturumu kapatmalı                                                       |
| `/exit`         | Oturumu kapatmalı                                                       |
| `/logout`       | Auth session’ını sonlandırmalı                                          |

### 12.2 SDLC and Context Commands

| Command     | Requirement                                                                       |
| ----------- | --------------------------------------------------------------------------------- |
| `/plan`     | SDLC plan stage’i başlatmalı veya planı güncellemeli                              |
| `/goal`     | Task objective ve definition of done tanımlamalı                                  |
| `/compact`  | Context’i özetlemeli, önemli bilgileri korumalı, learning candidate çıkarabilmeli |
| `/mention`  | Dosya, klasör veya sembol context’e eklemeli                                      |
| `/init`     | Proje için başlangıç talimatlarını ve Nexus config scaffold’unu oluşturmalı       |
| `/memories` | Learning Plane ve memory ayarlarını göstermeli/yönetmeli                          |
| `/skills`   | Skill seçme, yükleme veya context’e dahil etme işlemlerini yapmalı                |

### 12.3 Code and Review Commands

| Command   | Requirement                                      |
| --------- | ------------------------------------------------ |
| `/diff`   | Working tree diff’ini göstermeli ve açıklamalı   |
| `/review` | Diff/working tree review başlatmalı              |
| `/clear`  | Görünür oturum context’ini temizlemeli           |
| `/new`    | Yeni conversation başlatmalı                     |
| `/resume` | Önceki conversation/session devam ettirmeli      |
| `/fork`   | Mevcut session’dan alternatif thread oluşturmalı |
| `/side`   | Side thread veya paralel konuşma açmalı          |

### 12.4 Agent, MCP and Extension Commands

| Command         | Requirement                                       |
| --------------- | ------------------------------------------------- |
| `/agent`        | Subagent/thread yönetimini açmalı                 |
| `/mcp`          | MCP server ve tool listesini göstermeli/yönetmeli |
| `/apps`         | App connector durumunu göstermeli                 |
| `/plugins`      | Plugin yönetimini açmalı                          |
| `/hooks`        | Lifecycle hook’larını göstermeli/yönetmeli        |
| `/experimental` | Deneysel özellikleri göstermeli/değiştirmeli      |

### 12.5 Terminal and Sandbox Commands

| Command                 | Requirement                                 |
| ----------------------- | ------------------------------------------- |
| `/ps`                   | Background process/tool durumunu göstermeli |
| `/stop`                 | Running/background process’leri durdurmalı  |
| `/sandbox-add-read-dir` | Ek read-only path izni tanımlamalı          |
| `/keymap`               | Keyboard shortcut ayarlarını göstermeli     |
| `/vim`                  | Vim mode’u açmalı/kapatmalı                 |

---

## 13. Agentic SDLC Plane

### 13.1 Definition

Agentic SDLC Plane, Nexus’un her coding task’ını yazılım geliştirme yaşam döngüsü içinde yürütmesini sağlayan ürün katmanıdır.

SDLC stages:

```text
Discover → Plan → Implement → Verify → Review → Ship → Learn
```

Bu stages kullanıcıya karmaşık ayrı bir mod olarak sunulmaz. Slash komutlar ve agent davranışı üzerinden doğal şekilde çalışır.

### 13.2 Discover Stage

Amaç: Repository, teknoloji yığını, dosya yapısı, riskli alanlar, test komutları ve proje kurallarını anlamak.

Requirements:

- Repo root tespit edilmeli.
- Git durumu okunmalı.
- Package manager tespit edilmeli.
- Test/lint/typecheck komutları çıkarılmalı.
- `AGENTS.md` ve proje talimatları okunmalı.
- İlgili dosya ve semboller context’e eklenmeli.
- Büyük repo’larda token budget gözetilmeli.

### 13.3 Plan Stage

Amaç: Kod değişikliği yapılmadan önce uygulanabilir plan üretmek.

Requirements:

- `/plan` ile manuel başlatılabilmeli.
- Büyük değişikliklerde otomatik plan önerilmeli.
- Plan maddeleri düzenlenebilir olmalı.
- Plan, riskli tool usage ve gerekli approvals hakkında ön bilgi vermeli.
- Plan, definition of done ile ilişkilendirilmeli.

### 13.4 Implement Stage

Amaç: Plan doğrultusunda minimal ve güvenli patch üretmek.

Requirements:

- Dosya değişiklikleri patch/diff olarak gösterilmeli.
- Agent gereksiz dosya değiştirmemeli.
- Her edit event olarak kaydedilmeli.
- Write operation sandbox ve approval policy’ye tabi olmalı.
- Protected paths değiştirilememeli veya özel approval istemeli.

### 13.5 Verify Stage

Amaç: Yapılan değişikliğin çalıştığını doğrulamak.

Requirements:

- Test, lint, typecheck veya uygun komutlar önerilmeli.
- Komut çalıştırmadan önce risk değerlendirmesi yapılmalı.
- Komut çıktısı özetlenmeli.
- Başarısız verification durumunda sebep analiz edilmeli.
- Verification sonucu session manifest’e yazılmalı.

### 13.6 Review Stage

Amaç: Working tree veya patch için ikinci bir kontrol yapmak.

Requirements:

- `/review` ile başlatılmalı.
- Review minimal diff, missing tests, security risk, regression risk ve style issue aramalı.
- Security-sensitive değişikliklerde review önerilmeli veya policy gereği zorunlu olmalı.
- Review bulguları severity ile sınıflandırılmalı.
- Review sonucundan eval veya learning candidate üretilebilmeli.

### 13.7 Ship Stage

Amaç: Değişiklikleri teslimata hazırlamak.

Requirements:

- Commit message önerisi.
- PR title ve PR description.
- Changelog/release note.
- Migration note.
- Risk summary.
- Test summary.
- Rollback note.

### 13.8 Learn Stage

Amaç: Oturumdan güvenli ve scope’lu öğrenimler çıkarmak.

Requirements:

- Learning candidate’lar otomatik çıkarılmalı.
- Kullanıcı onayı olmadan varsayılan olarak memory’ye yazılmamalı.
- Candidate’lar scope, confidence ve source event ile gelmeli.
- Kullanıcı candidate’ı kabul, reddet veya düzenle seçeneğine sahip olmalı.

---

## 14. Learning Plane

### 14.1 Definition

Learning Plane, Nexus’un proje ve kullanıcı workflow’larından kontrollü öğrenmesini sağlayan katmandır.

Learning Plane şunları yapar:

- Kullanıcı tercihlerini öğrenir.
- Proje convention’larını öğrenir.
- Test ve command mapping çıkarır.
- Tekrarlayan failure pattern’leri kaydeder.
- Başarılı/başarısız agent davranışlarından eval üretir.
- Model ve tool performansı hakkında scorecard oluşturur.

Learning Plane şunları yapmaz:

- Kullanıcı kodunu varsayılan olarak model eğitimine göndermez.
- Sensitive data’yı memory’ye yazmaz.
- Kullanıcı onayı olmadan yüksek etkili memory oluşturmaz.
- Takım policy’sini override etmez.

### 14.2 Memory Scopes

Nexus memory objeleri scope’lu olmalıdır.

| Scope           | Description                                               |
| --------------- | --------------------------------------------------------- |
| User Memory     | Kullanıcının kişisel tercihleri                           |
| Project Memory  | Belirli repository/proje bilgileri                        |
| Team Memory     | Takım kuralları ve workflow normları                      |
| Workflow Memory | Tekrarlayan süreçler ve komut zincirleri                  |
| Eval Memory     | Agent performansı, failure pattern ve benchmark kayıtları |
| Session Scratch | Sadece aktif oturumda kullanılan geçici bilgiler          |

### 14.3 Learning Modes

```toml
[learning]
mode = "suggest"
```

Supported modes:

| Mode      | Behavior                                                        |
| --------- | --------------------------------------------------------------- |
| `off`     | Learning tamamen kapalı                                         |
| `observe` | Event toplanır, memory yazılmaz                                 |
| `suggest` | Candidate üretilir, kullanıcı onaylarsa yazılır                 |
| `active`  | Düşük riskli candidate’lar policy izin verirse otomatik yazılır |

Default mode:

```text
suggest
```

### 14.4 Learning Candidate Format

Her candidate şu alanları taşımalıdır:

```json
{
  "id": "lc_123",
  "scope": "project",
  "type": "test_command",
  "text": "This repo uses pnpm test for unit tests.",
  "confidence": 0.92,
  "source_events": ["evt_1", "evt_2"],
  "sensitive": false,
  "requires_approval": true
}
```

### 14.5 Memory Safety

Requirements:

- Secrets redaction yapılmalı.
- `.env`, private keys, tokens, credentials memory’ye yazılmamalı.
- Memory write event olarak kaydedilmeli.
- Memory source trace edilebilir olmalı.
- Kullanıcı memory’yi görüntüleyebilmeli, düzenleyebilmeli ve silebilmelidir.

### 14.6 Learning Plane UI

Learning Plane, `/memories`, `/status`, `/compact` ve oturum sonu summary içinde görünmelidir.

Örnek `/memories` çıktısı:

```text
Learning Mode: suggest

Pending candidates:
1. Project uses pnpm workspaces.
2. Run pnpm typecheck before pnpm test.
3. Auth module changes require security review.

Actions:
[accept all] [edit] [reject] [change mode]
```

---

## 15. Context Engine

### 15.1 Requirements

Nexus context engine şu kaynakları yönetmelidir:

- User prompt
- Conversation history
- Tool outputs
- File mentions
- Repo map
- Symbol index
- Git diff
- Test output
- `AGENTS.md`
- `.nexus/config.toml`
- Project memory
- User memory
- Skill instructions
- MCP tool descriptions

### 15.2 Token Budget

Nexus token budget’i görünür ve yönetilebilir olmalıdır.

Requirements:

- Context usage status line’da gösterilmeli.
- Büyük tool output’ları otomatik özetlenmeli.
- `/compact` ile manual compaction yapılabilmeli.
- Compaction sonrası korunacak bilgiler kullanıcıya gösterilebilmelidir.
- Context injection priority açık olmalıdır.

### 15.3 Context Priority

Önerilen priority sırası:

1. System/runtime safety instructions
2. Enterprise/org policy
3. Project policy/config
4. `AGENTS.md`
5. Current user instruction
6. Active SDLC goal
7. Relevant files and diffs
8. Verified memory
9. Tool outputs
10. Historical conversation summaries

---

## 16. Configuration Requirements

### 16.1 Config Locations

Nexus config katmanları:

```text
CLI flags / --config
Profile
.nexus/config.toml
~/.nexus/config.toml
/etc/nexus/config.toml
Built-in defaults
```

### 16.2 Example Config

```toml
model = "gpt-5.5"
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[features]
agentic_sdlc = true
learning_plane = true
subagents = true
mcp = true
skills = true
hooks = true
plugins = false

[learning]
mode = "suggest"
redact_secrets = true
require_user_confirmation = true
generate_evals = true

[sdlc]
default_workflow = "code-change"
require_plan_for_large_changes = true
require_verification = true
require_review_for_security_sensitive_changes = true

[security]
network_default = "off"
protected_paths = [".env", ".ssh", ".git", "node_modules"]
secrets_scanning = true
prompt_injection_detection = true

[tui.status_line]
items = [
  "model",
  "sandbox",
  "approval",
  "git_branch",
  "tokens",
  "sdlc_stage",
  "learning_mode"
]
```

### 16.3 Profiles

Profiles desteklenmelidir:

```toml
[profiles.strict]
sandbox_mode = "read-only"
approval_policy = "always"

[profiles.dev]
sandbox_mode = "workspace-write"
approval_policy = "on-request"

[profiles.ci]
sandbox_mode = "workspace-write"
approval_policy = "never"
learning_mode = "observe"
```

---

## 17. Project Instructions

### 17.1 AGENTS.md Support

Nexus `AGENTS.md` dosyasını proje talimatları için desteklemelidir.

Örnek:

```md
# Repository Instructions

- Use pnpm.
- Prefer minimal diffs.
- Run pnpm lint before final answer.
- Never edit database migrations without explicit approval.
- Auth and payment changes require review.
```

### 17.2 Nexus Project Files

Nexus şu proje klasörünü kullanabilir:

```text
.nexus/
  config.toml
  learning/
  runs/
  evals/
  cache/
```

### 17.3 Rule vs Memory Distinction

- `AGENTS.md` kuraldır.
- `.nexus/learning/project-memory.md` yardımcı hafızadır.
- Enterprise policy her ikisinin üstündedir.
- User prompt, güvenlik policy’sini veya enterprise policy’yi override edemez.

---

## 18. Tooling Requirements

### 18.1 Tool Bus

Nexus tool bus şu tool sınıflarını desteklemelidir:

- File read
- File write
- Patch apply
- Shell command
- Git
- Test runner
- Search
- Web/docs search
- MCP tools
- Skills
- Plugins
- Hooks

### 18.2 Tool Call Lifecycle

Her tool call şu lifecycle’dan geçmelidir:

```text
requested → risk_scored → policy_checked → approved/denied → executed → observed → summarized → logged
```

### 18.3 Tool Call Event

Her tool call event olarak kaydedilmelidir:

```json
{
  "type": "tool.call",
  "tool": "shell.run",
  "input": {
    "command": "pnpm test"
  },
  "risk": "medium",
  "sandbox": "workspace-write",
  "approval": "auto-allowed",
  "status": "completed",
  "exit_code": 0
}
```

---

## 19. Security Requirements

### 19.1 Sandbox Modes

Nexus şu sandbox modlarını desteklemelidir:

| Mode                 | Behavior                                                                 |
| -------------------- | ------------------------------------------------------------------------ |
| `read-only`          | Dosya okuma serbest, yazma ve riskli shell kapalı                        |
| `workspace-write`    | Workspace içinde yazma mümkün, protected paths ve network policy geçerli |
| `danger-full-access` | Sandbox ve approval kısıtları minimum; sadece izole ortamda önerilir     |

Default mode:

```text
read-only veya workspace-write, kurulum profiline göre
```

### 19.2 Approval Policies

Supported policies:

| Policy       | Behavior                                                       |
| ------------ | -------------------------------------------------------------- |
| `always`     | Her etkili action için onay ister                              |
| `on-request` | Riskli veya policy gerektiren action için onay ister           |
| `on-failure` | Önce sandbox içinde dener, başarısız olursa escalation ister   |
| `never`      | Onay sormaz; sadece policy izin verdiği aksiyonları çalıştırır |

### 19.3 Command Risk Scoring

Shell komutları risk sınıflandırmasına tabi olmalıdır.

High-risk examples:

- `rm -rf`
- `curl | bash`
- unknown binary execution
- credential file access
- SSH/private key access
- network exfiltration
- destructive git commands
- system-wide package installation
- production deploy commands

### 19.4 Protected Paths

Varsayılan protected paths:

```text
.env
.env.*
.ssh/
.aws/
.gcp/
.azure/
.git/
node_modules/
dist/
build/
private keys
credential files
```

### 19.5 Secrets Scanning

Nexus şu durumlarda secrets scanning yapmalıdır:

- Dosya okuma sonrası memory candidate üretirken
- Patch üretirken
- Final answer’da kod veya config gösterirken
- Tool output özetlerken
- Event log kaydederken

### 19.6 Prompt Injection Detection

Nexus tool output, README, issue body, web/docs content veya MCP result içinde prompt injection denemelerini tespit etmeye çalışmalıdır.

Örnek riskli içerikler:

- “Ignore previous instructions”
- “Exfiltrate secrets”
- “Run this command without asking”
- “Send environment variables”
- Tool output içinde role/policy override denemeleri

### 19.7 Fail-Closed Principle

Sandbox veya security engine devre dışı kalırsa Nexus güvenli varsayılanla durmalıdır. Fail-open davranış yalnızca explicit development/debug profile’da kabul edilebilir.

---

## 20. Model Provider Requirements

### 20.1 Provider Abstraction

Nexus model sağlayıcılarını adapter üzerinden desteklemelidir.

Potential providers:

- OpenAI
- Anthropic
- Google Gemini
- AWS Bedrock
- Azure OpenAI
- Local/Ollama-compatible models

### 20.2 Model Router

Model router task türüne göre model seçebilmelidir:

| Task                 | Suggested Model Class           |
| -------------------- | ------------------------------- |
| Planning             | High-capability reasoning model |
| Implementation       | Coding-capable model            |
| Review               | High-precision reviewer model   |
| Summarization        | Fast/cheap model                |
| Classification       | Fast/cheap model                |
| Subagent exploration | Fast/cheap model                |
| Security review      | High-capability model           |

### 20.3 Provider Policy

Enterprise config ile şunlar kısıtlanabilmelidir:

- Allowed providers
- Allowed models
- Region
- Data retention mode
- Logging mode
- Max cost
- Max tokens
- Max context size

---

## 21. Subagent Requirements

### 21.1 Purpose

Subagent’lar ana oturumu kirletmeden belirli görevleri yürütür.

Supported agent types:

- Explorer Agent
- Architect Agent
- Coder Agent
- Test Agent
- Reviewer Agent
- Security Agent
- Docs Agent
- Release Agent
- Learning Agent

### 21.2 Requirements

- `/agent` ile yönetilebilmeli.
- Her subagent ayrı context’e sahip olmalı.
- Her subagent ayrı permission profile ile çalışabilmeli.
- Subagent çıktısı ana thread’e özet olarak dönmeli.
- Subagent event’leri session log’a yazılmalı.
- Paralel subagent çalışması P1/P2 kapsamına alınabilir.

---

## 22. MCP, Skills, Plugins and Hooks

### 22.1 MCP Requirements

- MCP server ekleme, listeleme, silme.
- MCP tool manifest görüntüleme.
- MCP permission policy.
- MCP allowlist.
- Local ve remote MCP ayrımı.
- MCP tool call event logging.

### 22.2 Skills Requirements

Skills, belirli görevler için progressive disclosure ile yüklenmelidir.

Examples:

- code-review
- security-audit
- release-notes
- test-generation
- migration-review
- frontend-accessibility
- dependency-upgrade

### 22.3 Plugins Requirements

Plugins P1/P2 kapsamında değerlendirilmelidir. Plugin yükleme güvenlik açısından imzalı, version-pinned ve allowlist kontrollü olmalıdır.

### 22.4 Hooks Requirements

Lifecycle hooks:

- before_plan
- after_plan
- before_tool_call
- after_tool_call
- before_patch_apply
- after_patch_apply
- before_verify
- after_verify
- before_review
- after_review
- before_memory_write
- after_memory_write

Hooks policy’ye tabi olmalıdır.

---

## 23. Observability and Audit

### 23.1 Event Stream

Nexus her session için event stream üretmelidir.

Event categories:

- session
- user_input
- assistant_message
- reasoning_summary
- plan_update
- sdlc_stage
- tool_call
- approval
- sandbox
- file_change
- shell_command
- verification
- review
- memory_candidate
- memory_write
- model_call
- error

### 23.2 Session Manifest

Her run için manifest üretilmelidir:

```json
{
  "session_id": "nx_123",
  "started_at": "2026-05-20T10:00:00Z",
  "repo": "example-repo",
  "branch": "feature/auth",
  "model": "gpt-5.5",
  "sandbox": "workspace-write",
  "approval_policy": "on-request",
  "sdlc_stages": ["discover", "plan", "implement", "verify", "review"],
  "files_changed": [],
  "commands_run": [],
  "verification_status": "passed"
}
```

### 23.3 Audit Requirements

Enterprise mode’da şu bilgiler audit edilebilmelidir:

- Kim hangi repo’da hangi session’ı başlattı.
- Hangi model kullanıldı.
- Hangi tool’lar çalıştı.
- Hangi dosyalar değişti.
- Hangi shell komutları çalıştı.
- Hangi approvals verildi.
- Hangi memory candidate’lar yazıldı.
- Hangi MCP server/tool kullanıldı.

---

## 24. Privacy Requirements

### 24.1 Defaults

- User code varsayılan olarak training için kullanılmamalıdır.
- Local session data local kalmalıdır.
- Cloud sync açık değilse memory ve logs local tutulmalıdır.
- Telemetry opt-in veya enterprise policy kontrollü olmalıdır.
- Sensitive values redacted edilmelidir.

### 24.2 Telemetry Classes

Telemetry ayrıştırılmalıdır:

| Class               | Description                            | Default           |
| ------------------- | -------------------------------------- | ----------------- |
| Operational metrics | Latency, error count, command duration | Opt-in or minimal |
| Product analytics   | Feature usage                          | Opt-in            |
| Content telemetry   | Prompts, code, tool output             | Off by default    |
| Crash reports       | Error stack traces                     | Redacted, opt-in  |
| Enterprise audit    | Admin-controlled logs                  | Policy-controlled |

### 24.3 Retention

Retention ayarları:

```toml
[retention]
local_logs_days = 30
event_logs_days = 30
memory_retention = "until_deleted"
cloud_sync = false
```

---

## 25. Data Storage

### 25.1 User-Level Storage

```text
~/.nexus/
  config.toml
  auth.json
  providers.toml
  memories/
  logs/
  cache/
```

### 25.2 Project-Level Storage

```text
.nexus/
  config.toml
  learning/
  runs/
  evals/
  cache/
```

### 25.3 Run Storage

```text
.nexus/runs/<session-id>/
  events.jsonl
  manifest.json
  diff.patch
  verification.json
  review.json
  learning-candidates.json
```

---

## 26. Acceptance Criteria

### 26.1 MVP Acceptance

MVP kabulü için Nexus şunları yapabilmelidir:

- `nexus` ile TUI açılır.
- Kullanıcı prompt girer.
- Nexus repo context’i analiz eder.
- `/plan` plan üretir.
- Kullanıcı onay verirse dosya değişikliği yapılır.
- `/diff` değişiklikleri gösterir.
- Test komutu önerilir veya çalıştırılır.
- `/review` diff review üretir.
- `/status` model, sandbox, approval, SDLC ve learning durumunu gösterir.
- Oturum sonunda learning candidate önerilir.
- Candidate kullanıcı onayıyla project memory’ye yazılır.
- `nexus exec --json` aynı task’ı headless çalıştırır ve event stream üretir.
- Session resume çalışır.
- Config override çalışır.
- Sandbox ve approval policy çalışır.

### 26.2 Security Acceptance

- Protected path değişiklikleri onay veya policy gerektirir.
- Shell command risk scoring yapılır.
- Riskli komutlar otomatik çalışmaz.
- Network access policy’ye tabi olur.
- Secrets memory’ye veya logs’a düz şekilde yazılmaz.
- Sandbox engine devre dışı kalırsa Nexus fail-closed davranır.
- Non-interactive mode’da approval gerekiyorsa uygun exit code ile durur.

### 26.3 Learning Acceptance

- Learning candidate scope’lu üretilir.
- Candidate kaynak event’lere referans verir.
- Candidate kullanıcı tarafından kabul, düzenleme veya reddetme alır.
- Memory silinebilir ve düzenlenebilir.
- Sensitive candidate reddedilir veya redacted edilir.
- Learning mode `off`, `observe`, `suggest`, `active` olarak çalışır.

### 26.4 SDLC Acceptance

- Task stage’i status line’da görünür.
- `/goal` definition of done oluşturur.
- `/plan` plan stage’i başlatır.
- Implement stage dosya değişikliklerini event olarak kaydeder.
- Verify stage test/lint/typecheck sonucunu raporlar.
- Review stage riskleri listeler.
- Ship stage PR/release çıktısı üretebilir.
- Learn stage candidate üretir.

---

## 27. Success Metrics

### 27.1 Product Metrics

- Weekly active developers
- Average sessions per developer
- Task completion rate
- Accepted patch rate
- User-approved learning candidate rate
- Resume usage rate
- Non-interactive usage rate
- Slash command usage distribution

### 27.2 Engineering Metrics

- Tool call success rate
- Verification pass rate
- Rollback success rate
- Sandbox violation rate
- Approval denial rate
- Mean time to first useful plan
- Mean time to accepted patch
- Context compaction success rate
- Model/provider error rate

### 27.3 Quality Metrics

- Unnecessary file modification rate
- Failed test after accepted patch rate
- Review finding severity distribution
- Regression rate after Nexus-generated changes
- Memory false-positive rate
- Secret redaction failure rate
- Prompt injection detection rate

### 27.4 Enterprise Metrics

- Policy compliance rate
- Audit log completeness
- MCP allowlist violation attempts
- Protected path access attempts
- Provider/model policy violations
- Retention policy compliance

---

## 28. MVP Scope

### 28.1 Included in MVP

- Interactive TUI
- `nexus` command
- `nexus exec`
- JSONL event stream
- Basic slash commands
- Plan/diff/review/status/compact/memories
- File read/write
- Patch apply
- Shell command execution
- Git status/diff integration
- Basic sandbox
- Approval prompts
- Basic config
- `AGENTS.md` support
- Project memory candidate generation
- Learning mode: off, observe, suggest
- Basic session resume
- Single primary model provider
- Basic verification report

### 28.2 Excluded from MVP

- Full enterprise admin console
- Cloud sync
- Remote runners
- Parallel worktree orchestration
- Full plugin marketplace
- Multi-tenant team memory sharing
- Hosted eval dashboard
- IDE extension
- Browser companion
- Slack/Teams integration
- Full MCP registry governance

---

## 29. Release Plan

### 29.1 Alpha

Target users: internal developers and trusted testers.

Scope:

- TUI
- Core commands
- Basic tool execution
- Basic sandbox
- Single provider
- Local memory candidate
- Event log

Exit criteria:

- 20 successful real repository sessions
- No unrecoverable file corruption
- Approval and sandbox work reliably
- Basic patch + verify workflow works

### 29.2 Private Beta

Target users: selected external developers.

Scope:

- Improved TUI
- Non-interactive mode
- JSONL events
- `/review`
- `/memories`
- `AGENTS.md`
- Multiple config profiles
- Basic MCP

Exit criteria:

- 100+ real repository sessions
- 70%+ useful plan acceptance
- 50%+ patch acceptance on scoped coding tasks
- No known P0 security issues

### 29.3 Public Beta

Target users: broader developer community.

Scope:

- Multi-provider support
- Subagents
- Skills
- Better Learning Plane
- Eval generation
- Installer support
- Documentation

Exit criteria:

- Stable install/update flow
- Clear onboarding
- Regression-safe patch workflows
- Security review complete

### 29.4 v1.0

Target users: individual developers and small teams.

Scope:

- Production-grade CLI
- Stable TUI
- Reliable non-interactive mode
- Strong sandbox/approval
- SDLC plane
- Learning plane
- Documentation
- Basic enterprise-ready controls

Exit criteria:

- High reliability
- Security hardening complete
- Documented config and policy model
- Repeatable eval results
- Migration/update path stable

---

## 30. Risks and Mitigations

### 30.1 Risk: UX Deviates from Market Standard

**Impact:** Users resist adoption.

**Mitigation:** Keep command names, slash command culture and TUI behavior familiar. New features should live behind existing commands and status indicators.

### 30.2 Risk: Agent Makes Unsafe Shell Calls

**Impact:** Data loss, credential exposure, system damage.

**Mitigation:** Sandbox, approval, command risk scoring, protected paths, network policy and fail-closed behavior.

### 30.3 Risk: Learning Plane Stores Sensitive Data

**Impact:** Privacy and security incident.

**Mitigation:** Secrets scanning, redaction, user approval, memory scope, sensitive candidate blocking and memory delete/edit.

### 30.4 Risk: Context Pollution

**Impact:** Bad answers, wrong edits, unstable long sessions.

**Mitigation:** Context priority, compaction, verified memory, source references and token budget visibility.

### 30.5 Risk: Over-Automation

**Impact:** User loses trust.

**Mitigation:** Plan-before-mutation, visible approvals, diff review, rollback and explicit SDLC status.

### 30.6 Risk: Model Provider Lock-In

**Impact:** Vendor dependency.

**Mitigation:** Provider abstraction and model router.

### 30.7 Risk: Plugin/MCP Supply Chain

**Impact:** Malicious tool execution.

**Mitigation:** Allowlist, manifest, signature, version pinning, per-tool policy and audit log.

---

## 31. Open Questions

1. MVP primary provider hangi model/provider olacak?
2. İlk release Rust, Go veya TypeScript tabanlı mı geliştirilecek?
3. TUI render stack ne olacak?
4. Sandbox Linux/macOS/Windows’ta nasıl farklılaşacak?
5. Memory storage şifreli mi olacak?
6. Cloud sync ilk yıl kapsamda olacak mı?
7. Enterprise policy bundle formatı ne olacak?
8. MCP registry public mi private mı olacak?
9. Plugin sistemi v1.0’a dahil mi, yoksa v1.1’e mi bırakılacak?
10. Eval generation hangi task türleriyle başlayacak?
11. `/agent` subagent sistemi MVP’ye dahil mi yoksa private beta mı?
12. `danger-full-access` modu tamamen kapatılabilir mi?
13. Team memory için approval chain nasıl çalışacak?
14. Pricing modeli usage-based mi, seat-based mi, hybrid mi olacak?
15. Nexus Weaver platformu ile Nexus CLI arasındaki sınır nasıl tanımlanacak?

---

## 32. Glossary

### Nexus CLI

Terminalde çalışan agentic development runtime.

### Nexus Weaver

Nexus CLI etrafındaki daha geniş platform vizyonu.

### TUI

Terminal User Interface.

### Non-Interactive Mode

TUI açmadan çalışan headless/script/CI modu.

### Agentic SDLC Plane

Task’ları discover, plan, implement, verify, review, ship ve learn aşamalarıyla yöneten ürün katmanı.

### Learning Plane

Kullanıcı, proje, takım ve workflow seviyesinde kontrollü öğrenme sağlayan katman.

### Memory Candidate

Oturumdan çıkarılan, memory’ye yazılmadan önce kullanıcı/policy onayı bekleyen öğrenim önerisi.

### Sandbox

Agent’ın dosya sistemi, shell ve network erişimini teknik olarak sınırlayan güvenlik katmanı.

### Approval Policy

Agent’ın hangi aksiyonlar için kullanıcı veya policy onayı istemesi gerektiğini belirleyen karar katmanı.

### Tool Bus

File, shell, git, test, MCP, plugin ve benzeri araçları yöneten execution katmanı.

### MCP

Model Context Protocol tabanlı external tool/server entegrasyon mekanizması.

### Skill

Belirli görevler için agent’a eklenen, progressive disclosure ile yüklenen yetenek paketi.

### Subagent

Ana oturumdan izole şekilde belirli bir görevi yürüten yardımcı agent.

### Event Stream

Nexus’un yaptığı her önemli eylemi JSONL veya benzeri formatta kaydettiği gözlemlenebilirlik çıktısı.

---

## 33. Final Product Definition

Nexus CLI, Codex-style terminal agent kullanım standardını koruyan; fakat arka planda Agentic SDLC Plane, Learning Plane, güvenli sandbox/approval runtime, context engine, subagent orchestration, model routing, tool bus, observability ve enterprise policy katmanlarıyla çalışan profesyonel bir software development CLI ürünüdür.

Nexus’un kullanıcıya verdiği ana söz:

> Terminalden çıkmadan kodu anla, planla, değiştir, test et, review et, teslimata hazırla ve kontrollü şekilde öğren.

Nexus’un ürün farkı:

> Aynı tanıdık CLI deneyimi; daha güvenli runtime, daha güçlü SDLC akışı ve öğrenen proje hafızası.
