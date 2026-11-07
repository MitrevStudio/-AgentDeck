# AgentDeck Mesh: свързани компютри и headless хостове

План (2026-11-07) за това AgentDeck на няколко компютъра да се виждат, да си показват сесиите и да стартират сесии
един на друг, и за **headless хост** – същата сървърна част без UI, вдигната на виртуална машина с една shell
команда, която всеки AgentDeck с UI вижда и ползва.

Стъпва на днешния код (клон `feat/compact-manager-ui` + `feat/orchestrator`): терминалите на AgentDeck
(`terminals.js` + DockPty), сканирането на сесиите в `main.js`, живия статус (`live.js`), git статуса, командния
център (`orchestrator.js`, MCP) и IPC повърхността на preload-а (`window.manager`, `window.terminals`). Основната
идея: **всичко, което main.js прави за сесиите и терминалите на този компютър, е "хост". UI-ят е консуматор на
хостове – локалния и отдалечените – през един и същ API.**

---

## 1. Думи

| Дума | Какво е |
|---|---|
| **Възел** (node) | Една инсталация на AgentDeck, с UI или без. Има постоянен `nodeId`, име (по подразбиране hostname), TLS идентичност (self-signed сертификат, виж §4). |
| **Работно място** (desktop) | Пълният AgentDeck: Electron + UI + хост. Windows. |
| **Хост** (host) | Сървърната част: проекти, сесии, жив статус, git, терминали, стартиране на агенти. Върви *вътре* в desktop-а и *самостоятелно* като headless демон. Това е, което в заданието се нарича "само клиент". |
| **Headless хост** | Хост без UI – `agentdeck-host`, systemd услуга на Linux VM (Windows headless – по-късно, DockPty вече го позволява). |
| **Връзка** (link) | Един WebSocket (WSS, взаимен TLS) между два възела. Симетричен протокол: и двете страни могат да искат и да отговарят. |
| **Сдвояване** (pairing) | Еднократното доверяване на два възела един на друг (код на екрана / токен от инсталацията). След него всеки знае отпечатъка на сертификата на другия. |

Desktop ↔ desktop: "клиент и сървър в едно" – един сокет между двата, и двете страни виждат всичко на другата.
Desktop → headless: desktop-ът вижда и управлява хоста; хостът не инициира нищо.

---

## 2. Какво вижда и може потребителят

**Настройки → Компютри** (нов таб до „Мрежа“):
- Този възел: име (редактира се), порт (по подразбиране 7421), превключвател „Видим в локалната мрежа“ (mDNS).
- **Намерени в мрежата**: списък от mDNS – име, вид (работно място / хост), версия, адрес – с бутон **Свържи**.
- **Добави по адрес**: `host:port` или IP, за мрежи без mDNS (VPN, друг VLAN).
- **Свързани**: име, вид, състояние (онлайн / офлайн от …), версия, платформа; **Забрави**. За headless хост – и
  **Подготовка** (чеклист: git, SSH ключ, `claude`, `codex`, `opencode`; всеки ред с „Поправи в терминал“).

**Сдвояване**: щракваш Свържи → другата страна показва 6-цифрен код (desktop: диалог; headless: токенът, който
инсталацията е отпечатала) → въвеждаш го → и двете страни записват доверието. Desktop–desktop: вторият веднага
вижда връзката и сесиите на първия, без да прави нищо.

**Страничната лента** (sidebar): проектите на всеки свързан възел под заглавие с името и точка за състоянието му;
локалните както сега (с „Този компютър“ като заглавие само щом има и други). В „Агенти“ работещите сесии на всички
възли, с етикет на възела. Търсенето (Ctrl+K) търси навсякъде.

**Терминалите**: панел може да показва терминал от друг възел – заглавието на таба носи името на възела.
Клавиатура, размер, поставяне на текст работят; картинки – фаза 6. Нова сесия / shell / resume на отдалечен проект –
същите бутони, същото място (таб, дясно, долу). „Explorer“ при отдалечен проект го няма.

**Git**: от менюто на проект – **Клонирай на…**: избираш възел, папка (браузър на отдалечената файлова система, по
подразбиране `~/work/<repo>`), бранч (нов от base, или съществуващ), по желание агент + prompt. Хостът клонира
(URL-ът на origin се взима от локалния проект), прави бранча, регистрира проекта и пуска сесията. Напредъкът се
вижда като job в панела.

**Командният център**: инструментите получават `node` – „пусни на devws нов бранч за BDD и го накарай да …“.

**Известия**: „Чака те“ от сесия на друг възел идва като балон тук, с името на възела.

---

## 3. Архитектура

```
                 desktop A (Windows, Electron)                    desktop B
  ┌────────────────────────────────────────────┐        ┌──────────────────────┐
  │ renderer (sidebar, panes, palette)         │        │                      │
  │        │ IPC: (node, …)                    │        │                      │
  │ main.js ── links.js ─── link(A↔B) ───WSS───┼────────┼── links.js ── host   │
  │   │          │                             │        │                      │
  │ host (local) └── link(A→vm1) ───WSS───┐    │        └──────────────────────┘
  └───────────────────────────────────────┼────┘
                                          ▼
                              vm1: agentdeck-host (Linux, systemd)
                              host core + mesh server, без UI
```

- **`src/host/`** – ядрото. Няма Electron, няма DOM, няма `t()`. Една фабрика `createHost({ dataDir, platform })`
  връща таблица с методи (`api.js`) и излъчва събития. Същият код върви в Electron main и в headless демона.
- **`src/host/platform/`** – каквото е различно по ОС: псевдоконзола (DockPty на Windows, `node-pty` на Linux),
  време на стартиране на процес (PowerShell `Get-Process` / `/proc/<pid>/stat`), верига родител→дете за
  `tab-links` (`Win32_Process` / `/proc/<pid>/status`), команден ред за стартиране на агент (PowerShell
  `-EncodedCommand` + prompt файл / `bash -lc` + prompt файл), „отвори папката“.
- **`src/mesh/`** – идентичност, сървър, клиент, откриване, сдвояване, мениджър на връзките и **маршрутизация**:
  всяко нещо в UI-я е `(node, id)`; `node === ""` е локалният хост, иначе методът минава по връзката.
- **`main.js`** остава Electron обвивката: прозорци, трей, глобални клавиши, IPC. IPC методите стават тънки:
  `handle("terminal:attach", (node, id) => links.call(node, "terminals.attach", { id }))`.
- **`host/`** (в корена на репото) – headless пакетът: собствен `package.json` (само `ws`, `node-pty`,
  `bonjour-service`, `selfsigned`), `bin/agentdeck-host.js`, `install.sh`, `agentdeck-host.service`. Изтегля се
  със sparse checkout (`host/` + `src/host/`), виж §6.

Layout-ът на панелите (`workspace.js`) **остава на desktop-а**, не на хоста: панелът пази `{ node, term }`. Хостът
държи само плоския списък терминали. Така един и същ отдалечен терминал може да е отворен на две работни места
едновременно (хостът праща изхода на всеки прикачен; входът се слива – както два клиента на tmux).

### 3.1 API на хоста (`src/host/api.js`)

Огледало на днешните IPC канали – една таблица, от която се регистрират и IPC-то, и методите по връзката:

| Група | Методи | Днес в main.js |
|---|---|---|
| `host` | `info` → id, име, вид, версия, платформа, кои агенти са на PATH, home | `agentsReady`, `app.getVersion` |
| `projects` | `list`, `add(path)`, `remove`, `rename`, `arrange`, групи, pin | `project:*`, `group:*` (без диалога – папката се избира с `fs.listDir`) |
| `sessions` | `list` (кешът на сканирането), `preview(agent,id)`, `delete`, `search(q)` | `app:get-data`, `session:*`, `search:text` |
| `live` | `list` | `live:get` |
| `git` | `status`, `refresh`, `branches(dir)`, `remoteUrl(dir)` | `git:*` |
| `terminals` | `list`, `open({cwd, kind, agent, sessionId, prompt})`, `attach`, `close`, `move(agent,id)`; двоични кадри `input`, `resize`, `output` | `launch:*`, `terminal:*` |
| `fs` | `listDir(path)`, `isDir(path)`, `home` | `fs:is-dir` |
| `repo` | `clone({url, dir, branch, base})` → job; `jobs.list`, `jobs.cancel` | няма |
| `setup` | `status` (git, ssh ключ, claude, codex, opencode), `sshKey.get/generate`, `knownHosts.add`, `gitIdentity.set` | няма |
| `node` | `update` (headless: `git pull` + `npm ci` + restart), `rename` | няма |
| събития | `data.changed`, `live.changed`, `terminals.changed`, `terminal.exit`, `git.changed`, `job.progress`, `setup.changed` | `broadcast(...)` |

Грешките са кодове (`folderMissing`, `sessionRunning`…), не преведени низове; UI-ят ги превежда с `i18n.js`.

### 3.2 Протокол по връзката

- Транспорт: WebSocket над TLS (`ws` + `node:https`). Един сокет на двойка възли; ако и двата се свържат
  едновременно, остава този, иницииран от възела с по-малкия `nodeId`.
- Текстови кадри: JSON `{ id, method, params }` → `{ id, result }` | `{ id, error: { code, message } }`;
  събития `{ event, data }`. Версия на протокола в `hello`-то; несъвместима → връзката се отказва с ясен текст.
- Двоични кадри (изходът и входът на терминалите, за да не минават през base64):
  `[type:1][termId:16 байта UUID][payload]` – `0` output (+ `end` 8 байта, както `terminals.js` го брои днес),
  `1` input, `2` resize (`cols:2 LE, rows:2 LE`). Същата идея като кадрите на DockPty.
- `attach` връща scrollback + `end`, after което идват само новите кадри – същото, което `workspace-ui.js` прави
  днес за локалните терминали (`writeAfter`), така че рендерерът не научава нищо ново.
- Изходът се праща само за терминали, които някой е прикачил; `detach` спира потока.

### 3.3 Какво мине през мрежата, и какво не

Транскриптите не се копират: `sessions.preview` и `sessions.search` се изпълняват на хоста, резултатът е малък.
Usage/цените – на хоста, като числа (фаза 6). Файлове (картинка за поставяне в отдалечен терминал) – качване през
връзката в temp папка на хоста (фаза 6).

---

## 4. Сигурност и сдвояване

Всеки сдвоен възел може да пуска произволни команди на другия – **доверието е сдвояването**, нищо друго.

- **Идентичност**: при първо стартиране възелът си прави ключ + self-signed сертификат (`selfsigned`, чист JS; срок
  10 години), пази ги в `userData/node/` (desktop) или `~/.agentdeck/host/` (headless). `nodeId` = SHA-256
  отпечатъкът на сертификата.
- **Взаимен TLS с pinning**: сървърът иска клиентски сертификат (`requestCert: true, rejectUnauthorized: false`) и
  проверява отпечатъка му срещу списъка на сдвоените; клиентът проверява отпечатъка на сървъра по същия начин.
  Без CA, без токени за пренасяне – доверието е списък от отпечатъци, симетричен.
- **Сдвояване**: несдвоен клиент получава само `pair.start` → сървърът показва/отпечатва 6-цифрен код (валиден 2
  минути, 5 опита, после нов) → `pair.finish(code)` → сървърът записва отпечатъка на клиента, клиентът – на
  сървъра. Headless хост без зрител: кодът е дългият **токен от инсталацията** (`agentdeck-host pair` го показва
  пак; `--pair-token` го задава предварително за скриптирани VM-и).
- **Забрави** на която и да е страна прекъсва връзката веднага.
- Портът слуша на всички интерфейси, но **не е за интернет** – LAN или VPN. Инсталаторът (NSIS) добавя правило за
  Windows Firewall за порта и за mDNS (UDP 5353); от сорс – `netsh` при първо включване, с питане.
- Без mDNS в документацията на сдвояването: откриването само казва „има такъв възел“; нищо не се доверява по mDNS.

---

## 5. Откриване

- **mDNS / DNS-SD** `_agentdeck._tcp.local`, TXT: `id`, `name`, `kind`, `ver`, `proto`. Библиотека
  `bonjour-service` (чист JS, Windows + Linux). Обявяване – само ако „Видим в мрежата“ е включено; търсене – докато
  табът „Компютри“ е отворен и веднъж при старт.
- Намерен, но несдвоен възел се показва само в Настройки; сдвоен възел се намира и по mDNS, и по последния
  известен адрес (запазен), с reconnect на 2 → 30 s.
- **Ръчен адрес** за мрежи без multicast. Резервен вариант, ако mDNS се окаже капризен на Windows (Windows 10+ има
  собствен mDNS responder на 5353): UDP broadcast на порта на AgentDeck със същия TXT – същият код, друг транспорт.

---

## 6. Headless хостът

```
curl -fsSL https://raw.githubusercontent.com/MitrevStudio/-AgentDeck/main/host/install.sh | bash
```

`install.sh` (идемпотентен, без root освен за пакети):
1. Проверява `git`, `node ≥ 22` (NodeSource или `fnm`), `build-essential`/`python3` само ако `node-pty` няма
   prebuilt за дистрибуцията.
2. `git clone --depth 1 --filter=blob:none --sparse` в `~/.agentdeck/app`, `git sparse-checkout set host src/host`
   – **само хост частта**, без Electron, без UI, без voice.
3. `npm ci --omit=dev` в `host/`.
4. systemd user unit `agentdeck-host.service` (`Restart=on-failure`, `loginctl enable-linger`), `WorkingDirectory`
   и `HOME` на потребителя, за да вижда `~/.claude`, `~/.codex`, `~/.ssh`.
5. Отпечатва: адрес, порт, име, **pairing token**, и какво още трябва: `claude` login, `codex` login, SSH ключ.

CLI `agentdeck-host`: `status`, `pair` (токенът), `update` (pull + `npm ci` + restart; desktop-ът може да го
поиска през `node.update`), `logs`, `uninstall`. Данни: `~/.agentdeck/host/` (node.json, registry.json, terminals/).

Терминалите на headless хоста са `node-pty` процеси, деца на демона: **умират с него**. Демонът се рестартира
рядко (crash, update), а агентите се възобновяват с `--resume` от запазения списък – същото, което
`restoreWorkspace` прави днес на Windows при рестарт на машината. Отделен pty-хост като DockPty за Linux – само ако
се окаже нужно (по-късно, същият протокол през Unix socket).

Windows headless: същият пакет + DockPty; `sc.exe`/Task Scheduler вместо systemd. Не е в първите фази.

---

## 7. Git работни потоци и идентификация

- **Клонирай на възел**: `repo.clone({ url, dir, branch, base })` – на хоста: `git clone <url> <dir>`,
  `git switch -c <branch> <base>` (или `git switch <branch>`), `projects.add(dir)`, по избор
  `terminals.open({ kind: "prompt", agent, prompt })`. URL-ът на origin се чете локално
  (`git remote get-url origin`); `https://` ↔ `git@` се предлага при нужда. Job с потоков изход (клонирането може
  да отнеме минути), отказ с `jobs.cancel`.
- **SSH ключ**: хостът си генерира `ed25519` (`setup.sshKey.generate`) и UI-ят показва публичния с „Копирай“ –
  добавяш го в GitHub/Gitea/сървъра. **Частен ключ не пътува** по подразбиране. Изрично „Изпрати ключ…“ (избираш
  файл от `~/.ssh` на desktop-а) – за deploy ключове, по връзката, записва се с `0600`. `known_hosts` на хоста се
  допълва за `github.com` и за хостовете на проектите (`setup.knownHosts.add`). `user.name`/`user.email` се
  попълват от локалния git config.
- **Вход на агентите**: `claude`/`codex` login е интерактивен (device flow) – „Поправи в терминал“ отваря
  отдалечен терминал с командата. API ключове (`ANTHROPIC_API_KEY`) – като променлива на околната среда на
  услугата (`~/.agentdeck/host/env`), задавана от UI-я; пази се само там, не се връща обратно.
- **Чеклист „Подготовка“** на картата на възела: `git`, `ssh` ключ + `known_hosts`, `claude`, `codex`,
  `opencode`, версия на хоста – зелено/червено, с действие на всеки ред.

---

## 8. Реорганизация на кода (фаза 1 – без промяна в поведението)

| От | Към | Бележка |
|---|---|---|
| `main.js`: `readRegistry`…`indexProjects`, `scan`, `watchTranscripts`, `cache`/`broadcast` | `src/host/sessions.js` | Излъчва `data.changed` вместо да пише в прозорците |
| `main.js`: `launchTerminal`, `launchAgent`, `launchNew`, `launchFresh`, `launchNewWithPrompt`, `moveToTab`, `agentCommand`, `check*` | `src/host/launch.js` | Windows Terminal (`wt.exe`) остава само в desktop платформата |
| `terminals.js`, `live.js`, `git-status.js`, `session-preview.js`, `prompt-launch.js`, `terminal-env.js`, `tab-links.js`, `file-chunks.js`, `search.js` + worker, `usage*` | `src/host/…` | Местят се; `search.js` ползва `node:sqlite` – проверка, че е наличен в Node на VM-а |
| `t()` в горните | кодове на грешки | `i18n.js` остава в UI |
| `main.js`: IPC `handle(...)` | генерира се от `src/host/api.js` + `links.route` | Аргумент `node` навсякъде, по подразбиране `""` |
| `preload.js` | същите функции + `node` | `window.manager.launchNew(node, agent, cwd, place)` |
| `workspace.js` панел `{ term }` | `{ node, term }` | `importState` на стар layout: `node: ""` |
| `renderer.js`, `workspace-ui.js`, `palette-ui.js`, `bar.js` | данните идват обединени: `{ nodes: [{ node, info, status, registry, sessions, live }] }` | Ключовете `sessionKey` стават `node/agent:id` |
| `orchestrator.js` инструменти | + `node` (име на възел или „here“) | `list_nodes` нов инструмент |

`scripts/check.js` остава; добавят се `scripts/test-mesh.js` (два хоста в един процес, сдвояване, терминал през
връзка) и `scripts/test-host-linux.sh` (в Docker: install.sh, старт, `host.info`).

---

## 9. Фази

| # | Фаза | Резултат, който се вижда | Обем |
|---|---|---|---|
| 0 | **Проверки и решения** | Потвърдено: `node-pty` prebuilt за Node 24 на целевата дистрибуция; Claude Code на Linux пише `~/.claude/sessions/<pid>.json` с `procStart` (формат); `node:sqlite` на VM-а; `bonjour-service` работи на Windows с включен системен mDNS; `selfsigned` + `ws` mTLS с pinning (малък спайк). Протоколът (§3.2) записан. | 1–2 дни |
| 1 | **Извличане на хоста** (§8) | Нищо ново за потребителя; `main.js` е обвивка, `src/host/` се стартира и от `node host/bin/agentdeck-host.js --local` на Windows като тест. Всички днешни функции работят както преди. | 4–6 дни |
| 2 | **Mesh основа** | Идентичност, сървър, клиент, сдвояване, mDNS, Настройки → Компютри. Две работни места се сдвояват; второто вижда проектите, сесиите и живия статус на първото в страничната лента (само четене). | 4–5 дни |
| 3 | **Отдалечени терминали и сесии** | Панел с терминал от друг възел; нова сесия/shell/resume там; палитрата; известия „чака те“ от друг възел; командният център с `node`. | 4–6 дни |
| 4 | **Headless хост** | `host/` пакет, Linux платформа (`node-pty`, `/proc`, `bash`), `install.sh`, systemd, pairing token, `agentdeck-host update`, чеклист „Подготовка“. VM с хост, сесии от двете работни места. | 5–7 дни |
| 5 | **Git потоци** | „Клонирай на…“ с нов бранч и prompt; SSH ключ (генериране, показване, изпращане), `known_hosts`, git идентичност; `claude`/`codex` login през отдалечен терминал. | 3–4 дни |
| 6 | **Довършване** | Картинки към отдалечен терминал; usage/цени по възел; Windows headless; ръчен адрес през VPN тестван; firewall правило в инсталатора; `node.update` от UI; изтриване на сесии отдалечено. | по нужда |

Фази 2 и 4 могат да вървят успоредно след 1 (различни файлове: `src/mesh/` срещу `host/` + `platform/linux.js`).
Всяка фаза е отделен клон и PR; фаза 1 е най-големият и най-рисков PR – без видими промени, само преместване, и
се тества като regression (session list, resume, терминали, restore на layout, командния център).

### Фаза 0 – резултати (2026-11-07, devws.mitrevstudio.com, Ubuntu 22.04 x64, Node 20.18 от NodeSource)

- **`node-pty` 1.1.0**: prebuilt за linux x64 glibc е в пакета, `bash` през pty тръгва и излиза чисто. ✅
- **`ws` 8.22, `bonjour-service` 1.4, `selfsigned` 5.5** се инсталират без build tools. `selfsigned.generate` в v5 е
  *async* (връща `{ private, public, cert, fingerprint }`). avahi не работи на devws и UDP 5353 е свободен, така че
  `bonjour-service` може да обяви услугата. ✅
- **`node:sqlite`** (търсенето в транскриптите, `search-worker.js`) **няма в Node 20** – иска Node ≥ 22.5. Системният
  Node на devws е 20 (NodeSource) и не се пипа: `install.sh` слага Node 22 LTS *за потребителя* (fnm в
  `~/.agentdeck/`), а търсенето на хоста е изключено, когато модулът липсва. ⚠️
- **Claude Code на Linux** пише `procStart` като изхода на `ps -o lstart= -p <pid>` с `LC_ALL=C TZ=UTC` (прочетено от
  самия CLI; на Windows – `GetProcessTimes` FILETIME или `Get-CimInstance … CreationDate.Ticks`). `live.js` на Linux
  проверява по същата команда. ✅
- devws няма `claude`/`codex`/`opencode` и `~/.claude` – инсталират се във фаза 4 (с питане).
- devws е 192.168.50.42/24 с ~18 docker bridge интерфейса: обявяването по mDNS трябва да е **само на eth0**
  (`bonjour-service` по подразбиране слуша на всички; дава се `interface`).

### Фаза 1 – състояние (2026-11-07, клон `feat/mesh`)

Направено, без промяна в поведението (проверено в тестов профил: списък, жив статус, git, usage, търсене, preview,
shell в таб, продължаване на сесия в split, командният център, затваряне на панели):
- `src/shared/` – `atomic-file.js`, `util.js`, `log-file.js` (от `voice/`); `src/host/` – `terminals.js`, `live.js`,
  `git-status.js`, `session-preview.js`, `prompt-launch.js`, `terminal-env.js`, `tab-links.js`, `file-chunks.js`,
  `search*.js`, `usage*.js`, `stop-session.ps1` (преместени, `require` пътищата оправени).
- Нови: `host/errors.js` (кодове вместо преведени низове; `main.js` ги превежда в `handle()`), `host/registry.js`
  (регистърът на проектите и подредбата), `host/sessions.js` (сканирането, кешът, наблюдението на транскриптите –
  бившите ~400 реда на `main.js`), `host/launch.js` (командите за нова/продължена/с prompt/с handoff сесия, проверките,
  терминал на хоста, „Премести тук“, изтриване), `host/index.js` – `createHost()` събира всичко в един обект със
  събития (`data`, `terminals`, `terminal:data`, `terminal:exit`, `usage`, `git`), `start()`, `flush()`, `stop()`.
  Търсенето се изключва само, когато `node:sqlite` липсва (headless на Node 20).
- `main.js` от 1461 на ~910 реда: прозорци, трей, IPC, Windows Terminal, подредбата на панелите, гласът.

Остава за фаза 1 (върви заедно с фази 2 и 4, защото формата му зависи от тях): `host/api.js` (таблицата с методи, от
която се регистрират IPC-то и методите по връзката), `platform/` (Linux pty, `ps -o lstart=`, `/proc` вериги,
`bash` команден ред), `{ node, term }` в панелите, `host/bin/agentdeck-host.js --local`. `git-status.js` и `usage.js`
са singleton-и на модула – два хоста в един процес (тестът на mesh-а) ще искат фабрики.

### Фаза 2 – състояние (2026-11-07, клон `feat/mesh`)

Направено и проверено с два екземпляра на една машина (отделни профили и портове) и с `scripts/test-mesh.js`:
- `src/mesh/identity.js` (self-signed сертификат, id = SHA-256 отпечатък, `node/node.json` с име, порт, видимост),
  `peers.js` (доверените възли + кодът за сдвояване: 6 цифри, нов след всяко сдвояване и след 5 грешни опита),
  `protocol.js` (JSON заявки/отговори/събития + двоични кадри), `server.js` (HTTPS + `ws`, иска клиентски
  сертификат), `client.js` (проверява отпечатъка след handshake – Node не вика `checkServerIdentity` при self-signed),
  `discovery.js` (`bonjour-service`, `_agentdeck._tcp`), `links.js` (един линк на двойка, tie-break по id,
  reconnect 2→30 s, pairing, `call`/`notifyAll`, събития `nodes`/`link`/`event`/`self`/`discovered`).
- `main.js`: `MESH_API` (само гледане: `host.info`, `sessions.list`, `live.list`, `git.status`), push на `data`/`git`
  и на живия статус (на 3 s при промяна) към свързаните; `remote` картина по възел → `mesh:nodes` към прозореца.
- Настройки → **Компютри** (`voice/ui/settings-nodes.js`): име, порт, видимост, код за сдвояване + „Нов код“;
  Свързани (онлайн/офлайн, Забрави); Намерени в мрежата (Свържи с код); Добави по адрес.
- Страничната лента (`nodes-ui.js`): заглавие на всеки възел с проектите му под локалните; работещите му сесии в
  „Агенти“ с името на възела; отдалечен проект в центъра – само за гледане (последни сесии и статус).

Бележки: Windows Firewall пита при първото слушане (от сорс – за electron.exe; инсталаторът трябва да добави правило,
фаза 6). mDNS намери другия екземпляр през eth0 (192.168.50.68). `host.info` още не се ползва от UI-я. Палитрата не
търси в другите възли (фаза 3).

### Фаза 3 – състояние (2026-11-07, клон `feat/mesh`)

Направено и проверено с два екземпляра: от A се отваря shell на B (панел в пространството на отдалечения проект),
входът стига до B, изходът идва на живо като двоични кадри (`src/mesh/frames.js`: `[type][uuid][payload]`), resize,
затваряне (терминалът на B умира); сесия на B се продължава от A (`kind: "resume"`).
- Хостът сервира на сдвоените: `terminals.list/open/attach/detach/close` (само терминали с `owner` = този peer;
  `terminals.js` пази `owner`, и те не влизат в собствената подредба/restore на хоста), плюс събитие `terminals` към
  всеки peer само с неговите терминали; `watchers` – кой peer е прикачен към кой терминал.
- Desktop: `remoteTerms` (id → възел, cwd, title…), панелите на отдалечени терминали са в пространство
  `node:<id>:<normPath>`; `workspace.json` пази `node` на всеки такъв терминал и при старт панелът се връща, щом
  възелът се свърже (`terminals.list` + повторен `attach`, scrollback-ът попълва пропуснатото); при офлайн възел
  панелът остава с бележка „офлайн“. IPC `mesh:launch(node, {cwd, kind, agent, sessionId, prompt})`.
- Панелът на отдалечен проект (`nodes-ui.js`): Терминал, нова сесия с всеки агент на възела, „Възобнови“ на последните
  сесии; таб-броячът до проекта.

Остава от фаза 3: палитрата да търси в другите възли; командният център с `node`; известия „чака те“ от друг възел;
`{node}` в заглавието на панела е суфикс в title (достатъчно засега).

### Фаза 4 – състояние (2026-11-07, клон `feat/mesh`)

Направено локално (проверено на Windows: демонът `node host/bin/agentdeck-host.js run --data-dir … --port 0` се
сдвои с тестов desktop, който видя проектите, сесиите и живия статус на хоста и отвори shell там през връзката):
- `src/mesh/serve.js` – `createServed({ host, env, info })`: методите, които един хост сервира (`host.info`,
  `sessions.list`, `live.list`, `git.status`, `terminals.*`), наблюдателите на изхода, push на `data`/`git`/`live`,
  клавишите и размерите от peer-а. Ползва се и от `main.js`, и от демона.
- `host/bin/agentdeck-host.js` – демонът: `run` (по подразбиране), `pair` (кодът), `status`, `logs`, `update`
  (`git pull` + `npm ci` + restart), `uninstall`. Опции `--data-dir`, `--port`, `--name`, `--pair-token`,
  `--no-discovery`, `--interface`. `host/package.json` (ws, selfsigned, bonjour-service, node-pty), `host/install.sh`
  (sparse checkout на `host/ src/host src/mesh src/shared`, `npm ci`, systemd user unit, linger, отпечатва кода).
- Linux: `src/host/terminals-pty.js` (node-pty, същия интерфейс като DockPty), `launch.commandFor` връща и `argv`
  (на Linux prompt-ът е аргумент, без файл), `live.js` проверява `procStart` с `ps -o pid=,lstart=`, `tab-links.js` с
  `ps -e -o pid=,ppid=`, `log-file.js` приема папка. `createHost` избира backend по платформа.

Не е проверено на Linux: node-pty backend-ът, `ps`-базираният жив статус, install.sh и systemd. Следващата стъпка е
devws (с разрешение): клонът трябва да е качен в GitHub, после
`AGENTDECK_BRANCH=feat/mesh bash <(curl -fsSL …/feat/mesh/host/install.sh)`; `claude`/`codex` там още ги няма.

---

## 10. Рискове и отворени въпроси

- **Claude Code на Linux**: `live.js` разчита на `procStart` като Windows FILETIME; на Linux стойността сигурно е
  друга (или липсва). Фаза 0 го проверява на истинска VM; резервен вариант – само `pid` + `startedAt`.
- **`node-pty`** иска native модул: prebuilt има за glibc x64/arm64; Alpine/musl – не. Скриптът проверява и казва.
- **mDNS на Windows** при включен системен responder: `bonjour-service` ползва `reuseAddr`; ако на практика губи
  пакети – UDP broadcast като резерва (§5).
- **Два desktop-а гледат един терминал**: входът се слива; приемливо (както tmux), но се казва в заглавието на
  панела („и на B“).
- **Сканирането на хоста** е същото като сега (транскриптите се четат на хоста); обединеният изглед на desktop-а
  държи N кеша – паметта е малка, но `data.changed` от N възела трябва да се обединява с debounce.
- **Layout и изчезнал възел**: панел на офлайн възел остава с „Няма връзка с X“ и бутон „Затвори панела“; при
  връщане се прикача отново (`attach` + `end`), както `restoreWorkspace` днес.
- **Версии**: възли с различна версия на протокола се отказват; `agentdeck-host update` и автообновяването на
  desktop-а трябва да вървят заедно – `proto` в `hello`, съвместимост назад с една минорна версия.
- **Сигурност на LAN**: сдвоен = пълен достъп. Няма роли „само гледане“ в първите фази; ако трябва – флаг на
  сдвояването (`viewOnly`) по-късно.
- **Отворено**: коя Linux дистрибуция са VM-ите (Ubuntu 24.04 се приема); дали хостът да публикува и web UI (не –
  desktop-ът е UI-ят; headless хостът няма страници); дали edge менюто да показва отдалечени проекти (фаза 6).

---

## 11. Отхвърлени варианти

- **SSH вместо собствен демон** (desktop-ът прави `ssh vm claude …`): терминалите стават лесни, но сесиите, живият
  статус, транскриптите и git статусът пак искат код на VM-а; и desktop–desktop на Windows през SSH е неудобно.
  Собственият хост покрива и двете с един протокол. SSH остава за git-а на хоста.
- **Централен брокер / облак**: противоречи на „няма backend“ (README); LAN + VPN стигат. Ако някога трябва през
  интернет – същият протокол през rendezvous relay, без промяна в хоста.
- **Копиране на транскриптите към desktop-а**: мегабайти при всяка промяна; preview и search се пускат на хоста.
- **Layout на хоста**: би позволил две работни места да споделят подредба, но прави панелите на desktop A зависими
  от хост B; подредбата е на този, който гледа.
