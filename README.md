# AgentDeck

**AI сесии, проекти и глас на едно място** (*AI sessions, projects and voice in one place*).

Локално desktop приложение за Windows: каталог на проектите, стартиране и възобновяване на AI coding CLI сесии,
диктуване и четене на глас. Доскоро се казваше AI Session Manager.

## Install

Изтегли `AgentDeck-Setup-x.y.z.exe` от [GitHub Releases](https://github.com/MitrevStudio/-AgentDeck/releases) и го
стартирай. Инсталира се само за текущия потребител (без администраторски права), папката може да се смени; прави
пряк път на desktop-а и в Start менюто.

Инсталаторът не е подписан, затова Windows SmartScreen го спира: **More info → Run anyway**
(*Повече информация → Изпълни въпреки това*).

**Start with Windows** (**Settings → General → Startup**): the installed app starts in the tray when you sign in,
without opening its window. It is turned on once after installing; turning it off sticks. A copy run from source
cannot use it (the switch is shown off and says why).

## Updates

Инсталираното приложение се обновява само от [GitHub Releases](https://github.com/MitrevStudio/-AgentDeck/releases):
проверява малко след стартиране и после на всеки 4 часа, изтегля новата версия във фонов режим и я инсталира тихо,
когато излезеш от AgentDeck. Щом е изтеглена, иконата в трея показва известие и „Рестартирай и обнови до x.y.z“ –
така се инсталира веднага и приложението тръгва отново.

- **Настройки → Общи → Обновления**: версията, състоянието, „Провери сега“, „Рестартирай и обнови“ и превключвателят
  **Автоматично** (`settings.json` → `ui.autoUpdate`). Изключен – AgentDeck само проверява и те известява, а новата
  версия изтегляш ти („Изтегли“ тук или в менюто на иконата); изтеглената се инсталира по същия начин.
- Без интернет, при ограничение от GitHub или при release, чийто инсталатор още не е качен, нищо не изскача –
  следващата проверка опитва отново.
- От сорс кода (`npm start`) и от разпакетирания билд (`dist/win-unpacked`) обновяване няма: обновява се само
  инсталираната версия.
- 1.0.0 и 1.0.1 още нямат обновяване: първата версия с него се инсталира веднъж ръчно, после се обновява сама.

## Proxy

**Настройки → Мрежа** определя как AgentDeck излиза в интернет: заявките към Gemini и OpenAI (диктуване, четене на
глас) и проверката за обновления. Те минават през мрежовия стек на Chromium (Electron `net`), не през `fetch` на
Node.js, затова следват прокси настройките на Windows и приемат сертификатите, на които Windows вярва (и тези на
корпоративно прокси, което инспектира TLS).

- **Като Windows** (по подразбиране) – прокси настройките на Windows, включително автоматичната конфигурация
  (WPAD, PAC скрипт). Прокси, което иска вход с Windows акаунта (NTLM, Kerberos), го получава само.
- **PAC скрипт** – адрес на конфигурационен скрипт (`http://…/proxy.pac`).
- **Ръчно** – един прокси сървър (`http://proxy.corp:8080`; също `https://` и `socks5://`) и **Без прокси за**
  (по подразбиране `<local>`; този компютър винаги е директно).
- **Без прокси** – директна връзка, каквото и да е настроено в Windows.
- **Потребител и парола** – само за прокси, което ги иска (Basic, Digest или NTLM с друг акаунт). Паролата се пази
  шифрована (DPAPI) като API ключовете и не стига до страницата. Отхвърлени ли са, заявката спира с „Прокси сървърът
  отхвърли потребителя и паролата“, без да пита отново и отново.
- **Провери връзката** пита `https://generativelanguage.googleapis.com/` с въведеното (запазено или не) и показва
  през кое прокси е минала заявката и за колко ms – или защо не е минала.
- **Ползвай проксито и в терминалите, които отварям за агентите** (изключено по подразбиране): новите терминали
  получават `HTTPS_PROXY`, `HTTP_PROXY` и `NO_PROXY` (с потребителя и паролата, URL-кодирани) и
  `NODE_USE_ENV_PROXY=1`. При „Като Windows“ и PAC проксито се определя в момента на отваряне.

Записва се в `settings.json`, ключ `network`. Важи за заявките на AgentDeck и за обновяването.

## Какво има в MVP

- Добавяне/премахване/преименуване на проектни директории.
- Отваряне на нов Windows Terminal tab в дадена директория.
- OpenCode: извличане на сесии чрез `opencode session list --format json` за добавените проекти и възобновяване с `opencode --session <id>`.
- Claude Code: откриване на локални `.jsonl` transcripts и възобновяване с `claude --resume <id>`, когато директорията може да бъде съпоставена.
- Codex CLI: откриване на локални `.jsonl` transcripts и възобновяване с `codex resume <id>`, когато директорията е налична в session metadata.
- Локален каталог в Electron `userData/registry.json`. Няма backend и няма cloud sync.
- Жив статус на Claude Code сесиите („Работи“ / „Чака те“) от `~/.claude/sessions/`.

## Меню от горния край на екрана

- Излиза от **дръжката** – малко полупрозрачно езиче като от матово стъкло в горния край на основния екран (като лентата на Remote Desktop). Задръж мишката върху нея за миг (~0,12 с) или щракни; щракването го оставя отворено и с фокус в търсенето, а отвореното с посочване се прибира, щом мишката излезе от менюто и дръжката.
- Дръжката се **влачи наляво-надясно** (само по горния ръб); мястото се помни и след рестарт. Влаченето не отваря менюто, а ако е отворено – го прибира. Докато работи приложение на цял екран (игра, презентация, видео), дръжката се скрива. Извън своето малко правоъгълниче не пречи на нищо – щракванията около нея стигат до прозорците отдолу.
- Отваря се и с глобалната клавишна комбинация (първата свободна от `` Alt+` ``, `Ctrl+Alt+Space`, `Ctrl+Alt+Shift+Space`; активната се вижда в менюто и в иконата в трея) – тогава също излиза под дръжката.
- При отваряне менюто „израства“ от дръжката за ~140 ms; затваря се веднага, а вътре всичко реагира без анимации. Ако анимациите в Windows са изключени, ефектът се пропуска – освен в Remote Desktop сесия, където Windows ги изключва по подразбиране заради връзката, а не по твой избор.
- Проектите са иконки в хоризонтален ред (скрол с колелцето). При задържане върху проект отдолу излизат сесиите му и бутони за нова Claude/OpenCode/Codex сесия, терминал и Explorer.
- Търсенето намира проекти и сесии; ако напишеш пълен път до папка, предлага нова сесия там.
- Клавиши: `↑`/`↓` сесия, `←`/`→` проект, `Enter` отвори, `Esc` изчисти/затвори.
- Приложението остава в трея, след като затвориш основния прозорец. Оттам (и от **Настройки → Общи**) се скрива дръжката – тогава менюто се отваря само с клавишната комбинация и от иконата – и се излиза.

## Sessions: show terminal, preview, git status

- **Show terminal** – a running Claude Code session (one with a live status) gets **Show terminal** in place of
  Resume: on its card in the manager, and in the edge menu as the highlighted button of its row (clicking the row or
  `Enter` does the same). AgentDeck brings that session's terminal to the front – in Windows Terminal the very tab,
  otherwise the window of the app it runs in (VS Code, Git Bash, a classic console). **Open again** still starts a
  second instance on the same conversation, after a warning.
- **Preview** – the edge menu shows the highlighted session (or the first one) in a pane beside its rows; in the
  manager, resting the pointer on a session card for a moment opens the same preview beside the list. It has the
  last prompts and replies, the first prompt, the model, how many prompts, replies and subagents there are, and when
  the session started and was last active. Transcripts are only read.
- **Git status** – the branch of a project or session folder, a dot when it has changes (red with conflicts) and
  ↑/↓ for commits ahead of/behind its upstream: on the edge menu's tiles, in its header for the chosen project (with
  the staged / changed / untracked counts) and beside projects and session folders in the manager; the tooltip has
  the details. Strictly read-only: `git status` runs without optional locks and nothing is ever fetched, so ↑/↓ are
  as of your last fetch.

## Usage and cost

**Usage** in the manager's header opens the tokens and the **API-equivalent cost** of the Claude Code, OpenCode and
Codex sessions on this computer: totals for today, the last 7 and 30 days and all time, a chart per day (cost or
tokens), and the top projects, sessions and models. Session cards and edge-menu rows show the session's cost as a
small chip, and the edge menu's header the project's total.

*API-equivalent* is what these tokens would cost at the providers' public pay-as-you-go API prices (as of the date
the view names; `src/usage-prices.js`). Subscription plans (Claude Pro/Max, ChatGPT, Copilot) are not billed per
token, so it is not what you paid. Models without a known price show tokens only. Transcripts and OpenCode's
database are only read; a cache in `userData` keeps later passes quick.

## Език и тема

- Интерфейсът е на **български** или **английски**; темата е **тъмна**, **светла** или **системна** (следва Windows).
- Сменят се от **Настройки → Общи** (бутонът „Настройки“ в основния прозорец или „Настройки…“ в менюто на иконата в
  трея) или бързо от менюто на иконата: **Език ▸** и **Тема ▸**. Смяната на езика презарежда отворените прозорци;
  темата се сменя на място.
- Записите, направени преди смяната (например текстът на грешка в историята), остават на езика, на който са записани.
- Всички текстове са в `src/i18n.js` (ключ → `en` / `bg`); цветовете са токени в `src/theme.css` (`:root` е тъмната
  тема, `:root[data-theme="light"]` – светлата).

## Глас: диктуване и четене на глас (бившият VoiceTray)

Приложението включва всичко, което правеше VoiceTray. **VoiceTray не бива да работи едновременно** – и двете искат едни и същи клавишни комбинации; ако някоя е заета, иконата в трея казва коя (и дали VoiceTray още работи).

- **Диктуване – `Ctrl+Space`**: първото натискане започва запис (плаващ панел долу в средата на екрана с живата вълна на гласа и таймер), второто го спира. `Esc` отказва записа (заета е само докато се записва). Текстът се поставя в прозореца, който беше отпред при старта на записа; ако той вече не може да бъде върнат отпред, текстът остава в клипборда („натиснете Ctrl+V“). Записът може да се пусне и от менюто на иконата в трея („Запиши“) – тогава текстът отива в клипборда.
- **Четене на глас – `Ctrl+Shift+Space`**: прочита маркирания текст (Gemini TTS). Повторно натискане спира; панелът има пауза, стоп и скорост. Клипбордът се връща какъвто беше.
- **Неуспешни записи** не се губят: панелът показва грешката с „Опитай отново“, иконата в трея получава оранжева точка, а менюто ѝ предлага повторен опит, „Опитай всички отново“ и „Изхвърли всички“. Щракване върху известие за грешка също опитва отново.
- **История** и **Настройки → Диктовка / Речник / Четене на глас** (доставчик OpenAI/Gemini, модел, език, микрофон, максимална дължина, режим, речник, глас и модел за четене, API ключове, клавишни комбинации): от менюто в трея или от бутоните в горната лента на основния прозорец.
- При първото стартиране настройките, API ключовете и историята се пренасят еднократно от `%APPDATA%\VoiceTray` (само се четат). Записи, направени във VoiceTray след това, не се пренасят.

### Dictation modes, dictionary, push-to-talk

- **Modes** (**Settings → Dictation → Text**): *Verbatim* – the text as recognized; *Clean* – without fillers, false
  starts and repetitions, same language and meaning; *Prompt* – free speech becomes a clear prompt for a coding agent
  (in the language spoken or in English). Clean and Prompt send the transcript once more to the provider's fast text
  model (Gemini `gemini-3.1-flash-lite`, OpenAI `gpt-4.1-mini`) with your key. The chip on the voice panel switches
  the mode for one dictation; should the rewrite fail, the text is pasted as recognized. **History** keeps both
  versions (*Result* / *As recognized*).
- **Dictionary** (**Settings → Dictionary**): *terms* (names, technical words) steer recognition and the rewrite;
  *replacements* fix what still comes out wrong (“сигноз” → “SigNoz”; whole words, any case); the project names can
  count as terms too.
- **Push-to-talk** (**Settings → Dictation → Hotkey**): *Tap or hold* (default) – tap to start and tap again to
  finish, or hold the keys while you speak and let go to finish; or only *Tap*, or only *Hold*.

### Voice commands

Hold the edge menu's hotkey (usually `` Alt+` ``), say what to do and let go – the menu opens at the press as always,
and stays open while you speak. The microphone in the edge menu's header does the same with clicks (click it again,
click the voice panel or press the dictation key to finish). For example:

- “new session in BDD: fix the login bug” – a new Claude session in that project, started on a prompt written from
  what you said;
- “open the session about the logs” – brings that session back: its terminal if it is running, otherwise resumed;
- “codex in bdd-web: add tests” – a new session with another agent.

What you say is recognized like a dictation and matched against your projects and recent sessions. Before anything
runs, a card on the voice panel says what will happen and counts down (3 s by default): **Run now** starts it at
once, **Esc** or **Cancel** stops it, the pointer resting on the card pauses it; when it is unclear, the card offers
up to three choices. **Settings → Commands**: on or off, holding the hotkey or the menu's microphone only, the agent
of a new session, how its prompt is written (Prompt / Clean / Verbatim) and the countdown. Every command is kept in
**History** (kind *Commands*). To understand a command, the selected provider gets what you said, the names of your
projects and their folders and the titles and first prompts of recent sessions – never full paths.

Данни (в Electron `userData`): `%APPDATA%\ai-session-manager`, ако тази папка съществува (останала от предишното име –
не се мести, защото ключът, с който са шифровани API ключовете, е в нейния `Local State`), иначе `%APPDATA%\AgentDeck`.

- `settings.json`, ключ `ui` – език, тема и автоматично обновяване; `edgeHandle` – дръжката на менюто (`show` – дали се показва, `x` – мястото ѝ като част от ширината на екрана; заменя предишния ключ `hoverEdge`, чиято стойност се пренася); ключ `voice` – гласовите настройки; API ключовете са шифровани с Windows DPAPI (`safeStorage`), никога в чист текст.
- `voice/records/` – записите и прочетените текстове (`{id}.wav` + `{id}.json`, същият формат като при VoiceTray). Аудиото се пази 14 дни (до 1 GB общо), текстът – 90 дни (до 500 записа); неуспешните остават (до 50), докато не ги изтриеш.

Зависимости: `koffi` (извиквания към Windows API – глобални клавиши, клипборд, симулиране на Ctrl+V/Ctrl+C) и `soundtouchjs` (промяна на скоростта на четене без промяна на височината на гласа). И двете се инсталират с `npm install`.

За тестове: променливата `AGENTDECK_USER_DATA` (старото име `ASM_USER_DATA` също работи) пуска отделна инстанция с друга `userData` папка (заключването за единствена инстанция е на папка). `AGENTDECK_UPDATE_URL` насочва обновяването на инсталираното приложение към generic feed (папка с `latest.yml` и инсталатора, напр. локален HTTP сървър) вместо към GitHub.

## Изисквания

- Windows 10/11
- Node.js 22.12+ (препоръчително 24 LTS – същата версия като в Electron 44)
- Windows Terminal (`wt.exe`)
- Инсталиран и конфигуриран CLI за всеки агент, който използваш (`opencode`, `claude`, `codex`)

## Стартиране от сорс кода

1. Разархивирай проекта.
2. Отвори PowerShell в директорията `ai-session-manager`.
3. Изпълни:

   ```powershell
   npm install
   npm start
   ```

## Създаване на Windows build

```powershell
npm run check     # синтактична проверка на src/
npm run dist      # инсталатор: dist/AgentDeck-Setup-<версия>.exe (+ .blockmap и latest.yml)
npm run dist:dir  # само разпакетираното приложение: dist/win-unpacked/AgentDeck.exe
```

Билдът е с electron-builder (настройките са в `package.json`, ключ `build`). Локално версията е
`0.0.0-development` – истинската идва от release тага.

## Releases

Версията не се пази в репото. При всеки push в `main` semantic-release чете conventional commits след последния
таг, решава следващата версия, слага таг `vX.Y.Z` и създава GitHub release като чернова; Windows инсталаторът се
билдва от този таг, закача се към release-а (`.exe`, `.blockmap`, `latest.yml`) и чак тогава release-ът се публикува
(`.github/workflows/release.yml`). Така обновяването на инсталираните копия никога не вижда release без инсталатор;
ако билдът се провали, остава само чернова.

- `fix: …` → patch (1.2.3 → 1.2.4)
- `feat: …` → minor (1.2.3 → 1.3.0)
- `feat!: …` или `BREAKING CHANGE:` във footer-а → major (1.2.3 → 2.0.0)
- `docs:`, `chore:`, `refactor:`, … → без нов release

Pull request-ите и останалите branches минават само CI (`npm run check` + билд без инсталатор).

## Известни ограничения на първата версия

- Първо добави директориите, с които работиш най-често. Това позволява на приложението да извлича OpenCode сесиите за тези проекти и да съпоставя някои transcript-и.
- Claude Code transcript директориите кодират пътищата по начин, който може да варира. Ако сесията не може да бъде съпоставена надеждно, тя ще се покаже без директно Resume действие.
- Форматите на локалните transcript-и са детайли на конкретните CLI продукти и може да се променят. Това е best-effort discovery, не официален общ API.
- Откриването е локално и не променя/изтрива историята на агентите.
- Няма възстановяване на жив процес/състояние на затворен терминал. Resume стартира нов терминал и зарежда запазения разговор на агента.
- Поддържа се само Windows Terminal (`wt.exe`) в този MVP.
- За production версия бих добавил тестове на адаптерите, индексиране на сесии, поддръжка на други терминали и надеждно парсване на метаданните.

## Сигурност

Приложението не изпълнява произволни команди от заглавията/текстовете на сесиите. То стартира фиксирани CLI команди и предава session ID. Не добавяй функция за автоматично одобряване на разрешенията на агентите, без изрично да я проектираш отделно.
