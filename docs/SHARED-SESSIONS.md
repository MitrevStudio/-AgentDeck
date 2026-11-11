# Споделени сесии: терминалът е на компютъра, на който върви

План (2026-11-11, клон `feat/shared-sessions` върху `feat/mobile`) терминалите на AgentDeck да се държат като tmux:
**терминалът принадлежи на хоста, на който върви; устройствата се прикачат и откачат.** Сесия, пусната на pc2 – от
pc1, от телефона или от самия pc2 – се отваря едновременно навсякъде, всеки вижда кой още гледа и може да пише;
X само скрива панела; отделно „Спри“ (с потвърждение) наистина спира терминала за всички.

Стъпва на `docs/MESH.md` (§3) и `docs/MOBILE.md` (§6: широкия изглед на телефона). Телефонът вече се държи така –
тук правилата му стават общи и за desktop-ите.

---

## 1. Днес

| Случай | Какво става | Къде |
|---|---|---|
| Нова сесия локално | `launch:new` → `launchNew` → `launchTerminal` → (Windows Terminal според `sessionsIn`, или) `openTab` → `launch.openTerminal` (`owner` "") → `workspace.addTab(getSpaceFor(cwd))`. Desktop peer-ите не я виждат (`serve.js` `peerTabs`), телефонът – да (широк изглед). | `main.js` |
| Сесия на друг компютър | `nodes-ui.js` `onRemoteSpaceClick` → `mesh:launch` → `remoteLaunch` → `terminals.open` (там `owner` = pc1) → `remoteTerms.set` + `addTab("node:<id>:<path>")`. На pc2 този терминал е невидим в собствения му прозорец: `getWorkspaceView`, `getSavedWorkspace` и `restoreWorkspace` (unplaced) филтрират `!x.owner`. | `main.js`, `serve.js` |
| Клик на работеща сесия в „Агенти“, локална, панел тук | `openSession` → `showTerminal` → `showSessionTab` → `focus`. | `renderer.js`, `workspace-ui.js` |
| … отдалечена, в терминал, отворен от този desktop | `findSessionTab` я намира (`remoteTerms` са във view-то) → `focus`. | |
| … отдалечена, в собствен терминал на хоста или отворен от друг peer | Не е в `ws.terminals` → `showTerminal` → `s.node` → toast `manager.node.sessionThere`. На страницата на отдалечения проект живата сесия няма „Възобнови“ (`renderRemoteSpace`). **Не може да се отвори.** | `renderer.js`, `nodes-ui.js` |
| … локална, в терминал, отворен тук от peer (pc1) | Не е във view-то → етикет „в друг терминал“; `focusTerminal` → `focusSessionAnywhere` я намира в `terminals.getTabs()` → `showTab` → `workspace.focus` връща false: прозорецът излиза, панел няма. Менюто предлага „Премести тук“ (`isMoveHereOffered`): `launch.takeOverSession` не гледа терминалите на AgentDeck → `stop-session.ps1` убива агента в панела на pc1 и го продължава в нов таб тук. „Спри“ → `launch.stopSession` отказва `sessionRunning`. | `renderer.js`, `main.js`, `launch.js` |
| … извън терминал на AgentDeck | Локална: `terminal-focus.js` вдига прозореца ѝ; „Премести тук“. Отдалечена: toast. | |
| X на панел (и Ctrl+Shift+W, X на таба) | `closePane` (потвърждение при агент) → `close-pane` → `closeTerm`: локален → `terminals.close` (убива дървото); отдалечен → `terminals.close` на хоста – терминалът спира **за всички** (и за телефона). Desktop-ът никъде не вика `terminals.detach`. | `workspace-ui.js`, `main.js` |
| Терминал приключва | `terminal:exit` → `terminals.close` (`main.js`; `host/bin/agentdeck-host.js` при `--with-api`) → `terminals` → `prunePanes` / `reconcileRemote` → панелът изчезва без дума. Изгубен (DockPty убит): бележка `term.lost`, панелът остава. | |
| Изход и старт (Windows) | `before-quit` пази `workspace.json` (локални `!x.owner` + `remoteTerms` с `node`); `will-quit` → `detachAll` (DockPty живеят). Старт: `terminals.restore()` прикача всички записи (и тези на peer-ове – сервират се пак); панел без жив терминал (рестарт на машината, „Спри всички и излез“) → `reopenTerminal` с **нов id** (resume / shell); отдалечените панели чакат (`pending`). Работещ локален терминал без панел получава свой таб (само `!x.owner`). | `main.js`, `terminals.js` |
| Рестарт на headless (Linux) | node-pty терминалите са деца на демона; `stop` вика `stopAll`; нищо не се връща. Панелите на desktop-ите изчезват при свързване (`reconcileRemote`). | `terminals-pty.js`, `host/bin` |
| Възел офлайн и обратно | `link` down → бележка „офлайн“, входът се губи (`links.sendBinary`). Up → `terminals.list` (само своите) → `reconcileRemote` (изчезналите – без панел) → `terminals.attach` на всеки → scrollback, `writeAfter` пише само новото. | `main.js` |
| Два desktop-а, един отдалечен терминал | Невъзможно: `ownTerm`/`peerTabs` пускат само отворилия го. Само телефонът (широк изглед) вижда чужди. | `serve.js` |
| Размер | Панелът на desktop-а праща своя fit при всяка промяна (`fitTerm`, ResizeObserver) и не чува `terminal.size`. Широк peer, който е оразмерил, при detach/link down връща размера (`sizedBy` → `release` → `terminal:refit` / `terminal.refit`). Между два desktop-а правило няма – биха се дърпали. | `workspace-ui.js`, `serve.js` |

Защо сценарият на потребителя пропада: (1) `serve.js` дава на desktop peer само неговите терминали; (2) прозорецът
на хоста скрива терминалите, отворени от peer (`!x.owner` три пъти в `main.js`); (3) X е `terminals.close`, откачане
няма; (4) клик на чужда работеща сесия дава toast или празен прозорец, а „Премести тук“ убива агента в чуждия
панел; (5) размерът е на последния fit, без правило между desktop-и; (6) след рестарт панелите се отварят с нови id
(Windows) или изобщо не се връщат (Linux), така че другите устройства губят своите.

---

## 2. Целта

1. **Терминалът е на хоста.** Всеки peer с `control` (desktop, телефон) и собственият прозорец на хоста виждат
   всички негови терминали и могат да ги отворят, пишат в тях и спрат. `owner` остава само информация „отворен от“.
2. **Зрител** (viewer) = устройство с прикачен изглед: панел в подредбата му (и в скрит таб) на desktop, отворен
   екран „Терминал“ на телефон. Хостът знае зрителите и ги казва на всички.
3. **Отваряне на работеща сесия = прикачване** към терминала ѝ (`term` в живия статус). Втори `resume` на сесия, която
   върви в терминал на хоста, няма – хостът отговаря с този терминал.
4. **X = скрий** (detach), за агенти и за shell-ове. **Стоп = `terminals.close`** – терминалът свършва за всички,
   след потвърждение, отвсякъде (заглавието на панела, „Терминали“, менюто в „Агенти“, телефонът).
5. **Един размер.** Води последният, който е писал и има свой размер; другите показват терминала в него. Без
   ping-pong (§4.3).
6. Всяко устройство пази своята подредба; панелът сочи `(node, term)`.
7. **Възстановяването е на хоста**: терминал, умрял с машината или демона, се отваря наново със **същия id** (§4.6),
   така че панелите навсякъде го намират.
8. Сесия извън терминал на AgentDeck не се прикача; „Премести тук“ остава, но отказва сесия, която върви в терминал
   на AgentDeck.

---

## 3. Какво вижда и може потребителят

### 3.1 Desktop

**Заглавието на панела** (`.pane-info` вляво, `.pane-tools` вдясно – както днес, двете половини се рисуват поотделно):
- Вляво, след статуса: **зрители** – `eye` + броят на *другите* (само ако има), tooltip „Отворен и на: pc1, Pixel 8“.
  Ако е отворен от друго устройство – в tooltip-а на заглавието „Отворен от pc1“.
- Когато размерът е чужд: чип `120×32 · pc1`, tooltip „Размерът е на pc1 (писал последен). Пиши тук или натисни
  „Моят размер“.“ Терминалът се рисува в този размер, закотвен горе вляво: по-малък – празно поле; по-голям – панелът
  се скролва (`overflow: auto` на `.pane-body` само в това състояние).
- Вдясно: разделяне надясно/надолу, [изравни], [увеличи], **[`fit` – „Моят размер“, само при чужд размер]**,
  **`stop` (danger) – „Спри за всички“**, **`x` – „Скрий панела (Ctrl+Shift+W) · терминалът продължава“**.
- X и X/средният клик на таба скриват **без потвърждение** (нищо не се губи). Ctrl+Shift+W = скрий. Стоп няма клавиш.
- Стоп пита: агент – „Да спра ли „{title}“ на {where}? Терминалът се затваря на всички устройства{, гледат го и:
  {names}}. Разговорът остава и може да се продължи.“; shell – „Да спра ли терминала в {cwd} на {where}? Затваря се на
  всички устройства{…}.“ Бутон „Спри“ (danger).
- Терминал, който приключи или е спрян другаде: панелът изчезва и toast „„{title}“ приключи“. Офлайн възел: панелът
  остава с „офлайн“ (както днес) и се прикача пак при връщане. Отворен наново след рестарт: бележка „Отворен отново
  след рестарт“.

**„Агенти“** (`renderer.js` `renderAgents`): клик / Enter / двоен клик на сесия с `term` → панелът ѝ тук (фокус, или
нов таб в пространството на проекта ѝ – `node:<id>:<path>` за отдалечен), чий да е терминалът. Без `term`: локална –
прозорецът ѝ както днес; отдалечена – toast „върви извън AgentDeck на {node}“. `.here` = има панел тук. „в друг
терминал“ само без `term`. Меню: Покажи; Премести тук (само локална без `term`); копирания; **Спри** – с `term` →
спира терминала (всеки агент), без `term` → `sessions.stop` както днес (само Claude).

**„Терминали“** – нова секция в `#sideOverview` под „Агенти“ (`<section class="side-sec terms-sec" id="sideTerms">`,
заглавие + брой, скрита при 0). Редове: всеки работещ терминал на този и на всеки онлайн компютър, който „Агенти“ не
показва (shell-ове, clone терминали, агент без жива сесия). Ред като `.agent`: икона (`terminal` или знакът на
агента), заглавие, под него „{проект} · {компютър}“ и „· няма панел тук“ когато няма; вдясно `eye`+брой при зрители;
при hover `stop` icon-btn. Клик / Enter → отваря (фокус или нов таб). Ред с панел тук – `.here`. Ред: този компютър
първо, после по реда на компютрите; вътре най-новите първо.

**Отваряне отвсякъде** – палитрата (`palette-ui.js` `choose`), страницата на проект, edge менюто (`focusTerminal`),
командният център (`show_session`) – по същото правило: жива с `term` → прикачи; жива без `term` → локална: вдигни
прозореца ѝ / „Отвори въпреки това“ (`confirm.openAgain`, както днес), отдалечена: toast; спряна → resume.

### 3.2 Телефон

Видимо почти нищо: под заглавието на екрана „Терминал“ ред „и на: pc1“, когато други гледат. „Нагоди към
телефона“ взима размера изрично (§4.3 take), второ натискане и излизане го връщат (release / detach); натиснато веднага
след повторно свързване, изчаква attach-а (до 15 s), а при `notViewing` се прикачва и пита пак. X (спри) и
списъкът „Терминали“ на компютъра – както днес (`owner` етикетите остават).

### 3.3 Текстове (`src/i18n.js`; пакет C)

| Ключ | en | bg |
|---|---|---|
| `ws.closePane` (нов текст) | Hide the pane (Ctrl+Shift+W) · the terminal keeps running | Скрий панела (Ctrl+Shift+W) · терминалът продължава |
| `ws.hideTab` | Hide the tab | Скрий таба |
| `term.stopAll` | Stop for everyone | Спри за всички |
| `term.stopAgentConfirm` | Stop "{title}" on {where}? The terminal closes on every device{viewers}. The conversation stays and can be resumed. | Да спра ли „{title}“ на {where}? Терминалът се затваря на всички устройства{viewers}. Разговорът остава и може да се продължи. |
| `term.stopShellConfirm` | Stop the terminal in {cwd} on {where}? It closes on every device{viewers}. | Да спра ли терминала в {cwd} на {where}? Затваря се на всички устройства{viewers}. |
| `term.viewersSuffix` | , also open on: {names} | , гледат го и: {names} |
| `term.viewers` | Also open on: {names} | Отворен и на: {names} |
| `term.openedBy` | Opened from {name} | Отворен от {name} |
| `term.sizeBy` | {cols}×{rows} · the size of {name}, who typed last. Type here or press "Use my size". | {cols}×{rows} · размерът е на {name} (писал последен). Пиши тук или натисни „Моят размер“. |
| `term.useMySize` | Use my size | Моят размер |
| `term.ended` | "{title}" ended | „{title}“ приключи |
| `term.reopened` | Reopened after a restart | Отворен отново след рестарт |
| `term.noPane` | no pane here | няма панел тук |
| `manager.terms.title` | Terminals | Терминали |
| `manager.agents.outsideOn` | runs outside AgentDeck on {node} | върви извън AgentDeck на {node} |
| `errors.tooManyViewers` | Too many devices have this terminal open. | Твърде много устройства са отворили този терминал. |
| `errors.tooManyTerminals` | Too many terminals run on this computer. Stop some first. | На този компютър работят твърде много терминали. Спри някои първо. |
| `errors.sessionRunningOutside` | The session runs outside AgentDeck there. | Сесията върви извън AgentDeck там. |
| `errors.notViewing` | The terminal is not open here yet. Try again in a moment. | Терминалът още не е отворен тук. Опитай пак след малко. |

`ws.closeConfirm`, `ws.closeTabConfirm`, `confirm.closePane`, `ws.closeTab` са махнати. Телефонът: `term.viewers` в
`mobile/src/i18n.js` (пакет D) и същите грешки като `err.*`.

---

## 4. Протокол и хост

### 4.1 Методи, събития, кадри (`src/mesh/serve.js`)

Кой: всичко е за peer с `control` (`links.js` пуска заявка само тогава – desktop, телефон; никога реле или ресурсен
хост). Нищо не зависи от това кой е отворил терминала.

| Име | Днес | След |
|---|---|---|
| `terminals.list` `{all}` | `all:true` → всички + широк изглед за връзката; иначе само своите | Всички терминали на хоста за всеки; `all` се приема и не значи нищо. Tab по §4.2. |
| `terminals.open` `{cwd, kind, agent, sessionId, prompt}` | Отваря, `owner` = peer | Също, плюс: `kind:"resume"` на сесия, която върви в терминал тук → **нищо ново**, отговор `{...tab, already: true}`; жива извън терминал тук → `sessionRunningOutside`, освен с `force: true`. Над `MAX_TERMINALS` → `tooManyTerminals`. |
| `terminals.attach` `{id}` | Свой или широк | Всеки; записва зрител. → `{scrollback, end, exitCode, cols, rows, driver}`. Над `MAX_VIEWERS` → `tooManyViewers`. |
| `terminals.detach` `{id}` | Връща размера на телефона | Зрителят излиза (§4.3 detach). Терминалът продължава. |
| `terminals.close` `{id}` | Свой или широк | **Стоп** за всеки терминал. Име не се сменя: вече значи „спри на хоста“, телефонът го ползва, старите peer-ове също. |
| `terminals.resize` `{id, cols, rows}` / `{id, release: true}` | – | **Ново.** Взима размера изрично (take) / връща го (release). Само зрител – иначе `notViewing` (take, изпреварил attach-а след повторно свързване: устройството се прикачва и пита пак); `invalidData` при `cols`/`rows` извън цели 1..1000. → `{cols, rows, driver}`. |
| `terminals.send` `{id, text}` | Свой или широк | Всеки. Не е „писане“ за правилото за размера (`terminals.type`, не `input`). |
| `repo.clone` | `owner` = peer | Също + `MAX_TERMINALS`. |
| `sessions.stop` | Отказва `sessionRunning`, ако е в терминал тук | Без промяна (UI-ят вика `terminals.close` тогава). |
| `live.list` | Live[] | Всеки запис + `term`: id на терминала тук, в който върви сесията (`agent`+`sessionId`, неприключил), или "". |
| `host.info` | … | + `terminals: 2` – хостът говори тези правила (§6). |
| кадър `input` | От собственик или широк peer | От peer, направил поне една `terminals.*` заявка по текущата връзка (множество `ctl`, заменя `wide`; брои се и отказана заявка – до нея стига само peer с `control`) и който `links.sees`; само към неприключил терминал. За §4.3 се брои само ако е зрител и ако не е само отговор на терминала (`isReport`, §5.2) – той се пише с `terminals.type`. |
| кадър `resize` | Прилага се; широк peer → `sizedBy` | Само от зрител: **want** (§4.3), не директен resize. От друг – пуска се. |
| кадър `output` | На прикачените | Без промяна, + back-pressure (§4.5). |
| събитие `terminals` | Всеки – своите; широк – всички | Всички, на всеки онлайн peer, който `links.sees`. При промяна на табове, зрители или водач. |
| събитие `terminal.size` `{id, cols, rows}` | На широките зрители | `{id, cols, rows, driver}` на **всички** зрители; при промяна на размера или на водача. |
| събитие `terminal.refit` | На собственика при release | **Не се праща.** Hand-back-ът (§4.3) го поема на хоста. Новият desktop продължава да го слуша от стари хостове. |
| събитие `terminal.resync` `{id}` | – | **Ново.** Зрителят е изпуснал изход (§4.5): да се прикачи пак. |
| хост събитие `terminal:refit` | → `main.js` | Махнато. |

### 4.2 Tab

```
{ id, cwd, title, agent, sessionId, agentOnly, codexLog, pid, owner, exited, lost, createdAt, note,   // както днес
  ownerName,                          // името на отворилия ("" за owner "" или непознат)
  reopened,                           // true: хостът го отвори наново след рестарт (§4.6)
  viewers: [{ id, name, kind }],      // node id-та; собственият прозорец на хоста = node id-то на хоста
  driver }                            // node id на водача или null
```

Вътре в хоста (`host.tabs()`) собственият прозорец е `""`; `serve.js` го превежда на `links.self().id`, а имената
(`links.nodes()` + self) слага той. Размерът **не** е в Tab-а (би пращал целия списък при всяко влачене) – идва с
`attach` и `terminal.size`. В `host.tabs()` `ownerName` и `viewers[].name` са `""` (имената са на извикващия), `kind` на
зрителя е каквото е дадено на `viewers.attach` (за peer – неговият `kind`: `desktop` / `mobile`).

### 4.3 Зрители и размер (`src/host/viewers.js`, нов)

Състояние на терминал: размер `S`; водач `D` (зрител или null); зрители `V`: за всеки `want` (размерът, който иска,
или няма), `inputAt`, `attachedAt`. `HOLD` = 2 s. „Приложи W“ = `terminals.resize(id, W)` (нищо при същия размер).
Хостът излъчва `terminal:size {id, cols, rows, driver}` при промяна на `S` или `D` и `terminals` при промяна на `V`/`D`.

| Събитие | Източник | Условие | Ефект |
|---|---|---|---|
| attach(A) | `terminals.attach`; панел на хоста се появи в подредбата | броят на V < `MAX_VIEWERS` | `V += A` без want. `S`, `D` – без промяна. |
| want(A, W) | кадър `resize`; fit на панел на хоста | A ∈ V | `A.want = W`; ако `D = A` или `D = null`: `D = A`, приложи W. Иначе само се помни. |
| input(A) | кадър `input`; клавиш в панел на хоста | A ∈ V | `A.inputAt = now`; ако `A.want` и `D ≠ A` и (`D = null` или `D ∉ V` или `D` не е писал (`inputAt = 0`) или `now − D.inputAt ≥ HOLD`): `D = A`, приложи `A.want`. Зрител без want (телефон) не взима водача. |
| take(A, W) | `terminals.resize {cols, rows}` (телефон „Нагоди“, desktop „Моят размер“) | A ∈ V | `A.want = W`, `D = A`, приложи W. |
| release(A) | `terminals.resize {release}` (телефон „Върни размера“) | – | `A.want = няма`; ако `D = A` → hand-back. |
| detach(A) | `terminals.detach`; link down (`leave(A)` за всички); панел на хоста скрит | – | `V −= A`; ако `D = A` → hand-back. |
| hand-back | – | – | `D` = зрителят с want с най-голямо (`inputAt`, `attachedAt`, ред на прикачване); приложи want-а му. Няма такъв → `D = null`, `S` остава. |
| type | `terminals.send`, autopilot, `send-text.js` | – | Нищо (не са клавиши на човек). |
| exit / close | – | – | Състоянието се маха. |
| рестарт на хоста | – | – | `V` празно, `D = null`; първият want прилага (DockPty пази истинския размер, `terminals.js` брои default до тогава – както днес). |

**Няма ping-pong**: автоматичните събития (want от fit, attach) менят `S` само ако подателят е `D` или `D = null` – и
тогава той става `D`, така че втори автоматичен подател вече само се помни. `D` се сменя само от човешко действие
(input след `HOLD`, take, release) или от detach. Два панела, които fit-ват непрекъснато, не могат да се редуват. ∎
`sizedBy`, `release()`, `terminal:refit` и `terminal.refit` се махат: hand-back-ът прави на хоста това, което refit
искаше от панела (want-ът на панела вече е там).

### 4.4 Отваряне и спиране

- `terminals.open` не прикача: отварящият се прикача, щом покаже терминала (панел / екран). `D = null` до първия want.
- Resume защита (`launch.runningTab(agent, id)` – неприключил таб с тези `agent`+`sessionId`): `terminals.open` (§4.1)
  и локалният `launchAgent` в `main.js`. `launch.takeOverSession` („Премести тук“) отказва `sessionRunning` при
  `runningTab` – днес убива агента в чужд панел.
- Терминал без зрители: върви; изходът се пази в scrollback-а на backend-а (512K знака), поток няма; в списъците е.
  Нищо не го спира само.

### 4.5 Граници и back-pressure

- `MAX_VIEWERS = 16` на терминал; `MAX_TERMINALS = 64` работещи на хост (в `launch.openTerminal` – важи за всички
  пускания, и локалните); при възстановяване същата граница, най-новите първо.
- `links.buffered(id)` (нов; `protocol.js` → `ws.bufferedAmount`, web връзката – колкото дава pipe-ът, иначе 0).
  Изход към зрител с буфер > 4 MiB се пропуска и той се маркира „изостанал“; щом падне под 512 KiB (проверка при
  следващия изход и на 1 s, докато има изостанали) – веднъж `terminal.resync {id}`. Зрителят се прикача пак; изпуснатото
  идва от scrollback-а (`writeAfter` на desktop-а, `reattach` на телефона). Стар peer не знае `resync` – губи изход,
  вместо днешния неограничен буфер. Web връзка (`web-link.js`): `bufferedAmount` на сокета = на WebSocket-а под нея;
  телефон през релейния тунел (`framedPipe`) – `relay.js` `webEnd` подава `buffered: () => s.readableLength` на `io`
  (байтовете, чакащи тунела в края му тук), така че изоставането се хваща преди `MAX_WEB_BUFFER` (32 MiB) да затвори
  тунела (`test-web-link.js`).
- `attach` е ограничен от scrollback-а (512K знака) – както днес.

### 4.6 Възстановяване след рестарт

`host.restoreTerminals({ skip, env })` (нов, `host/index.js`) → `{ attached, kept, reopened }` (масиви от id):
- **Windows (DockPty)**. Изход на приложението → `detachAll`, както днес. Старт: записите с жив DockPty – прикачени
  (всеки отворил, както днес); записите с мъртъв DockPty днес се трият – **сега се отварят наново със същия id**
  (`terminals.open({ id, … })`): агент + `sessionId` → `launch.resumeCommand`; иначе shell в `cwd`; resume, който не
  става → shell; липсваща папка → записът се трие. `reopened: true`, `createdAt` и `owner` – старите.
  „Мъртъв“ = pid-ът не върви, или върви процес, който не е DockPty (`tasklist`; pid, взет наново след рестарт). DockPty
  под този pid без pipe с този id, pipe, който отговаря за друг терминал, или `tasklist`, който не отговори → записът
  се трие както днес и **не** се отваря (иначе агентът би вървял два пъти).
  `skip(meta)` – мъртви записи, които хостът не отваря (main подава `orchestrator.isOwn(cwd)`: командният център се
  връща с `orchestrator.open`, както днес); записите им се трият, както днес. Жив пропуснат запис се прикачва (както
  днес). `env` – средата за отворените наново (main подава `terminalEnv(process.env, proxy)`; по подразбиране без прокси).
  „Спри всички и излез“ (`stopAll`) трие записите веднага (синхронно, плюс опашката на `atomic-file`) → нищо не се
  отваря; `reopenTerminal` в `main.js` остава резерва само за панелите на този компютър (нов id, както днес).
  `terminals.restore()` на backend-а не отваря нищо: връща мъртвите записи в `dead` и ги оставя; отваря (или трие с
  `forgetEntry`) само `host.restoreTerminals()` – единственият, който го вика.
- **Linux (node-pty)**. Нов регистър `dataDir/terminals/<id>.json` (`{ id, createdAt, meta }` като DockPty): пише се при
  `open`/`link`, трие се при `close`/`stopAll`. Спиране на демона (SIGTERM/SIGINT, `agentdeck-host update`) →
  `detachAll()` = SIGHUP на децата **без** триене на записите и без `terminal:exit` (флаг `detaching`) – вместо
  днешния `stopAll` в `host/bin`. Старт: всички записи се отварят наново със същия id (`host/bin` вика
  `host.restoreTerminals()` преди мрежата).
- Така панелите на всяко устройство намират терминала след рестарта; зрителите и водачът започват отначало.

### 4.7 API на хоста (договор за пакет B)

```
host.viewers.attach(id, who, { kind })   -> { cols, rows, driver }   // HostError tooManyViewers / invalidData
host.viewers.detach(id, who)
host.viewers.leave(who)                  // link down: всички терминали
host.viewers.want(id, who, cols, rows)
host.viewers.input(id, who)
host.viewers.take(id, who, cols, rows)
host.viewers.release(id, who)
host.viewers.state(id)                   -> { cols, rows, driver, viewers: [who] } | null
host.tabs()                              -> Tab[] (§4.2, who-та, "" = този прозорец)
host.restoreTerminals({ skip, env })     -> { attached, kept, reopened }
host.liveSessions()                      -> Live[] + term
launch.runningTab(agent, sessionId)      -> Tab | null
събития: "terminals" (host.tabs()), "terminal:size" { id, cols, rows, driver };  "terminal:refit" – махнато
```
`who`: `""` – собственият прозорец на този компютър; иначе node id. Имената са на извикващия (`serve.js`, `main.js`).
`want`/`input`/`release`/`detach` от не-зрител не правят нищо; `want`/`take` с размер извън цели 1..1000 →
`invalidData`, `take` от не-зрител → `notViewing`. `isReport(data)` (същият модул) – входът е само отговори на
терминала (§5.2); `serve.js` и `main.js` не викат `input` за него. `attach` на вече прикачен – без промяна. Хостът сам маха състоянието на приключил/затворен
терминал. `host.terminals.resize` остава (директен resize, без водач) – само за стария път на `main.js`; новият
минава през `viewers.want`. Допълнително (не са договор, но са там): `viewers.list(id)`, `viewers.driverOf(id)`;
`host/index.js` изнася `equipTerminals(host, { terminals, launch, liveSessions })` и `terminalEvents(host)` – така
тестовите fixture-и (`test-shared-terminals.js`, `test-mobile-provider.js`) правят същия хост без сканиране;
backend-ите имат и `size(id)`, `forgetEntry(id)`, `restore()` → `{ attached, kept, dead }`, `open({ id, createdAt, reopened })`,
`link(id, agent, sessionId, { replace })`.

### 4.8 Смяна на сесията в същия терминал (`tab-links.js`)

`/clear` (и подобни) в Claude Code започва нов session id в същия процес; табът пази първия, защото `linkTabs` гледа
само табове без `sessionId`. Сега: кандидати са и свързаните табове, чийто `agent:sessionId` вече не е жив; жива сесия
на същия агент във веригата на процеса им → `terminals.link(id, agent, newId, { replace: true })` (DockPty записът и
регистърът се обновяват – след рестарт се продължава последният разговор). Прозорецът до свързването е ≤ 1 цикъл (3 s).
Codex – без промяна (`codex-live.js` свързва по лога): Codex табове не се свързват наново тук. Цена: `tab-links` чете
живия статус на всеки цикъл, докато върви поне един терминал (досега – само докато имаше несвързан).

---

## 5. Desktop

### 5.1 Състояние в `main.js`

- `remoteLists` (node → Tab[]) – целият списък на хоста (`terminals.list` без `all`, събитие `terminals`); от хост без
  `terminals: 2` – само своите. Отделно от `remote` (не отива в `mesh:nodes`).
- `remoteTerms` – отдалечените терминали **с панел тук** (и `pending` от възстановяването): маршрут id → node за
  вход, размер, attach. `reconcileRemote` обновява и двете; изчезнал там → панелът си отива (+ `terminal:ended`).
- `wants` – последният fit на прозореца по терминал (за „Моят размер“ и за повторен attach: след attach main праща
  want-а – кадър `resize` / `viewers.want`).
- `panedIds` – терминалите с панел в подредбата (от `workspace` `onChange`). Изходът (`terminal:data`, локален и
  отдалечен) и `terminal:size` отиват в прозореца **само** за тях – прозорецът не рисува терминал без панел.
- `sentEnd` – докъдето прозорецът е получил изхода на терминал с панел. Панел, чийто xterm е останал (връзката се
  върна, `terminal.resync`), получава само пропуснатото: опашката на scrollback-а от `sentEnd` до `end`
  (`desk.missedOutput`). Скрит панел губи и xterm-а си (`renderWorkspace` маха изгледите без панел), така че
  `panesChanged` забравя `sentEnd` му; отворен пак, панелът се прикачва наново с целия scrollback (`attachTerm`), без
  „дупка“. Нищо не се пише два пъти.
- `attachWaits` – attach-ите на прозореца за панел на офлайн възел чакат (не връщат null): при връщането на възела
  получават отговора. Иначе панелът би трупал изход в опашката си завинаги (`attachedEnd === null`).
- `shownTitles` / `stoppedHere` – голите заглавия на панелите, както са показани последно (за `terminal:ended`), и
  терминалите, спрени от този прозорец (за тях `ended` не идва; също при „Спри всички и излез“).
- Аз: локално `""`, на отдалечен хост `links.self().id`.
- `syncLocalViewers()` след всяка промяна на подредбата и на `terminals`: локалните неприключили терминали с панел →
  `viewers.attach(id, "", { kind: "desktop" })` (+ want-ът, ако има), без → `detach` (`desk.viewerDiff`).
- **Мрежата тръгва след възстановяването** (`restoring.finally(startMesh)`, като `host/bin`): peer, свързал се по-рано,
  би получил списък без отваряните наново терминали и панелите му към тях биха изчезнали (видяно в живия тест).

### 5.2 Един път за локален и отдалечен

| Действие | Локален | Отдалечен |
|---|---|---|
| attach (панелът се създаде) | `terminals.attach` (зрителят е от подредбата) | `terminals.attach` (+ want) |
| вход | `terminals.input` + `viewers.input(id, "")`; отговорите на терминала (`isReport`) – `terminals.type`, без `viewers.input` | кадър `input` (хостът прави същото разделяне) |
| fit | `viewers.want(id, "", c, r)` – никога директно `terminals.resize` | кадър `resize` |
| „Моят размер“ | `viewers.take(id, "", want)` | `terminals.resize {id, cols, rows}` → `terminal:size` |
| скрий (X, `close-tab`, Ctrl+Shift+W) | `workspace.removeTerm` → `syncLocalViewers` | `removeTerm`, `remoteTerms.delete`, `terminals.detach` (и при `legacy`) |
| спри | `terminals.close` | `terminals.close` |
| отвори (Агенти, Терминали, палитра, edge меню, `show_session`) | фокус, или `workspace.addTab(getSpaceFor(cwd), id)` / `split` | фокус, или `remoteTerms.set` + `addTab(desk.remoteSpace(...))` / `split` |

`desk.remoteSpace`: най-дълбокият проект на онзи компютър, който съдържа `cwd`, иначе самата папка
(`node:<id>:<normPath>`). Новите `remoteLaunch` (без `already`) и `remoteClone` – както днес (`args.cwd` / `tab.dir`).

**Отговорите на терминала не са писане.** xterm.js сам отговаря на въпросите на програмата (позиция на курсора,
device attributes, режими, focus in/out, OSC/DCS отговори) – и на въпроси, които преиграва от scrollback-а: ConPTY пита
за курсора при всеки старт, така че всеки нов изглед на терминал праща `ESC[r;cR`. Брояно като `input`, това правеше
водач всеки, който просто отвори терминала (видяно в живия тест). `isReport(data)` (`host/viewers.js`; вход, който е
*само* такива отговори: CPR и DECXCPR, DSR 5, DA1/2/3, DECRQM, XTWINOPS, focus in/out, OSC и DCS отговори) →
`terminals.type` (не `input`, не `viewers.input`, не трие „отворен наново“) – в `main.js` за локалните и в `serve.js`
за кадрите на peer-ите (desktop и телефон). Клавиш никога не е отговор: Shift/Ctrl/Alt+F3 (`CSI 1;m R`, m 2..16) се
брои за писане, също paste и мишка (таблиците в `test-terminal-viewers.js`).

`!x.owner` се заменя с „има панел тук“ (`workspace.findTab`): `getSavedWorkspace` пази terms на панелите;
`getWorkspaceView` дава всички; `restoreWorkspace` **не** слага вече табове на работещи терминали без панел (unplaced) –
те са в „Терминали“ (със скриването като нормално състояние, автоматичното им слагане би отменило X).
`focusSessionAnywhere` / `showTab` (и командният център): табът на сесията (чий да е) → панел тук (нов таб в
пространството ѝ, ако няма). `launchAgent`: `runningTab` → панел (`open-term`), не resume. `remoteLaunch`: отговор с
`already` → панел на съществуващия. `stopAllAndQuit`: под текста на потвърждението – `term.viewers` с имената на
устройствата, които гледат някой от терминалите (без нов ключ).

### 5.3 IPC (договор B ↔ C, `preload.js`)

| `window.terminals.` | Канал | |
|---|---|---|
| `attach(id)` | `terminal:attach` | → `{scrollback, end, exitCode, cols, rows, mine, by}` или null (няма такъв / панелът скрит, докато възелът е офлайн). Панел на офлайн възел: отговорът **чака** възела. |
| `input(id, data)` | `terminal:input` (send) | както днес; отговорите на терминала не се броят (§5.2) |
| `resize(id, cols, rows)` | `terminal:resize` (send) | want; цели 1..1000, иначе се пуска; main го помни |
| `takeSize(id)` | `terminal:take-size` (нов) | → true; последният `resize` на панела става размерът (`invalidData` без такъв). Новият размер идва и с `onSize`. |
| `stop(id)` | `terminal:stop` (нов) | → true. `id` на всеки терминал – и такъв, който не е във view-то: main намира компютъра (локален → `remoteTerms` → списъците → `term` в живия статус на онлайн възел; `desk.nodeOf`); непознат → `invalidData`, офлайн → `offline`. |
| `command("open-term", { term, place })` | `workspace:command` (нов cmd) | `term`: всеки терминал без панел тук, локален или отдалечен, и такъв, познат само от `term` в живия статус (main пита `terminals.list`, ако го няма в списъка). С панел → фокус. Новият панел е фокусираният в активното пространство: `place` `tab` (нов таб в пространството на проекта му), `right` / `down` (до фокусирания панел на показания таб). → true. |
| `command("close-pane" / "close-tab", …)` | както днес | значи **скрий** |
| `onSize(cb)` | `terminal:size` (нов) | `{id, cols, rows, mine, by}` – само за терминали с панел тук |
| `onEnded(cb)` | `terminal:ended` (нов) | `{id, title}`: терминал с панел тук приключи / спрян другаде (не и от този прозорец). `title` е голото заглавие, без „ · възел“. |
| `onRefit(cb)` | както днес | само от стари хостове |

Размер (`attach`, `onSize`): `mine` – този прозорец води (`by` е тогава името на този компютър); `mine: false, by: ""` –
**никой не води** (панелът се fit-ва сам, без чип); `mine: false` с непразен `by` – размерът е на друго устройство.
`by` е `""` точно когато водачът е null; иначе винаги има име (непознат възел – първите 8 знака на id-то). `legacy` –
винаги `mine: false, by: ""`.

`window.manager` – без промяна (`stopSession` е за сесии без терминал). `getLive()` – записите имат `term`; също и
`live` на всеки възел в `getNodes()`/`onNodesChanged` (идва от `live.list` / събитие `live` на хоста): `term === ""` –
върви извън AgentDeck; `term` липсва – по-стар хост; `term` – върви в този терминал.

**View** (`workspace:changed`, `workspace:get`): `{ activeSpace, spaces, tabs, terminals }`, `terminals` = всички
локални + всички на онлайн компютрите (не телефоните) + отдалечените с панел на офлайн компютри (или на онлайн, чийто
списък още не е дошъл). Всеки (`desk.composeView`): полетата на Tab (§4.2) +
- `node` ("" локален), `paned` (има панел тук), `legacy` (хост без `terminals: 2`: без зрители и размер);
- `viewers: [{ id, name, kind, me }]` – локално зрителят `""` е този прозорец (`id` = id-то на този възел, `me: true`);
  отдалечено `me` = `id === links.self().id`; `driver: { name, me } | null`;
- `ownerName` – `""`, когато го е отворил този компютър (локален `owner ""` или отдалечен с `owner === links.self().id`),
  иначе името на отворилия;
- `reopened` – от Tab-а, **не** в `note`. Решение: важи, докато някой не пише в терминала **от този прозорец** (първият
  истински клавиш – не отговор на терминала); после е false в този прозорец до края на работата му. Всеки desktop го
  гаси за себе си; без промяна в хоста (там флагът живее до следващия рестарт на хоста – след него прикаченият DockPty
  вече не е „отворен наново“);
- `title` със суфикс „ · възел“ за отдалечен (както днес), `note` (локален – бележката на хоста, напр. `term.lost`;
  отдалечен – „офлайн“ при офлайн възел, иначе "").
`bar.js` (`w.terminals` → „отворена в AgentDeck“) работи без промяна.

### 5.4 Възстановяване на подредбата

| Панел в `workspace.json` | При старт |
|---|---|
| локален, DockPty жив | прикачен (както днес) |
| локален, отворен наново от хоста (същия id) | остава; бележка `term.reopened` |
| локален, няма го и хостът не го отвори (`stopAll`, командният център) | `reopenTerminal` (нов id), както днес |
| локален, `kept` | панелът отива (както днес) |
| отдалечен, възелът офлайн | `pending`, „офлайн“ (както днес) |
| отдалечен, терминалът там (и отворен наново) | `terminals.attach` |
| отдалечен, няма го там | панелът отива |

Редът: `host.restoreTerminals({ skip: m => orchestrator.isOwn(m.cwd), env })` (`env` – `terminalEnv(process.env,
proxy)`, проксито чакано най-много 10 s) → `desk.restorePlan` (чиста: `keep` / `remote` / `reopen` / `drop`) →
`reopenTerminal` за `reopen` → `workspace.importState` → `prunePanes`. `terminals.restore()` вече не се вика. Работещ
терминал без панел не получава таб (е в „Терминали“). Мрежата тръгва след това (§5.1).

`workspace.json` остава `version: 1`, `workspace.js` (панел `{ term }`, възелът – в `remoteTerms`/`terms`) – без
промяна. `terms` пази терминалите с панел тук (чий да е отворил ги).

### 5.5 UI (`workspace-ui.js`, `renderer.js`, `nodes-ui.js`, `palette-ui.js`)

- Терминалът се рисува в `{cols, rows}` от `attach`/`onSize`; `fitTerm` праща want (`fit.proposeDimensions()`) и
  преоразмерява xterm към своя fit веднага само при `mine` (или `driver: null`), иначе към размера на хоста. `legacy` –
  fit винаги, както днес. Want-ът се мери без скролбарите на `.sized` (иначе е с клетка по-малък и терминалът се
  преоразмерява два пъти, щом панелът поеме размера).
- `closePane`/`closeTab` – без потвърждение, `close-pane`/`close-tab`. Стоп – бутонът в `.pane-tools`, ред в
  „Терминали“, менюто в „Агенти“ → `confirmDialog(danger)` → `terminals.stop(id)`. Резерви за по-стар main няма
  (`preload.js` и UI-ят вървят заедно); за по-стари **хостове** – `legacy` и `onRefit`.
- `renderWorkspace` пази xterm изглед само за терминалите с панел в подредбата (всеки таб, всяко пространство); изход
  за терминал без панел не създава изглед. Пространство без табове изпразва `#panes` – `.pane[data-term]` не остава.
- `findSessionTab` търси във всички `ws.terminals` (вече и без панел); `showSessionTab` → `focus` при `paned`, иначе
  `open-term`. `isMoveHereOffered` / `isStopOffered` – по `term` в живия статус.
- `openSession`, `resume`, `showTerminal`, палитрата – §3.1.
- `nodes-ui.js`: жива сесия с `term` на страницата на отдалечен проект → бутон „Покажи терминала“ (`open-term`).
- Нова икона `fit` в `common.js` (от `mobile/src/icons.js`).

### 5.6 Командният център и „Премести тук“

`orchestrator.js` – без промяна (и в кода): `show_session` минава през `focusSessionAnywhere` (отваря панел за
сесия в терминал без панел), `showTab` на main (`centre:start`, отговорът му) слага панел на скрития команден
център, `send_to_session` вече намира всеки локален таб (`send-text.js` `tabOfSession`), `start_session` – локално.
Сесии на други компютри в командния център – извън този план. „Премести тук“ – както днес, плюс отказа в хоста (§4.4).

---

## 6. Съвместимост

Способността: **`host.info.terminals: 2`**. Hello и `PROTOCOL` не се пипат: вдигане на протокола отрязва всеки стар
възел, а новите правила се търпят от старите peer-ове. Peer-ът не обявява нищо – правилата на хоста са едни за всички.

| Хост ↔ peer | Какво става |
|---|---|
| нов хост ↔ нов desktop / телефон | Всичко по §4. |
| нов хост ↔ стар desktop (≤ v1.11) | `terminals.list` връща всички, `reconcileRemote` пипа само своите – без ефект. Прикачва се при панел → зрител. Fit-ът му е want; рисува в своя размер, така че докато не води, картината му е разместена – води, щом пише. **X при него е `terminals.close` – спира терминала за всички**; `resume` на вече работеща сесия получава съществуващия таб (`already`). |
| нов хост ↔ стар телефон (`feat/mobile`) | Списък, attach, close – както досега. „Нагоди“ праща кадър `resize` = want: важи веднага при `D = null`, иначе щом пише; при излизане – hand-back. `driver`, `viewers` се пренебрегват. |
| стар хост (без `terminals: 2`) ↔ нов desktop | Desktop-ът пита `terminals.list` **без** `all` (и при хост от `feat/mobile`, за да не става широк peer с `sizedBy`): само своите, `legacy: true`. X → `terminals.detach` (има го от фаза 3; терминалът остава, в „Терминали“ е). Без зрители, без „Моят размер“, fit винаги, `terminal.refit` се слуша. Чужди сесии – toast, както днес. |
| стар хост ↔ нов телефон | Без `terminals: 2`: „Нагоди“ с кадър `resize`, както днес. Без `terminals.list { all }` (преди `feat/mobile`) – `missing`, както днес. |

Миграция: `workspace.json` – нищо; Windows регистърът – непроменен (`meta.owner` остава); Linux регистърът – нов,
празен при първия старт.

---

## 7. Рискове и гранични случаи

- **Забравени shell-ове**: „Терминали“ ги показва с „няма панел тук“ на всеки компютър; трей tooltip-ът ги брои
  (`countRunning`); след рестарт се отварят наново най-много `MAX_TERMINALS` (§10.1).
- **Двама пишат**: входът се слива (tmux); заглавието казва кой още гледа; `HOLD` 2 s пази размера да не скача при
  едновременно писане. Заключване няма.
- **Бавен зрител**: §4.5; на другите не пречи – изходът към всеки е отделен.
- **Спрян, докато друг пише**: `terminals` без него → панелите си отиват с `term.ended`, телефонът показва
  „приключи“; кадри към несъществуващ id се пускат (`serve.js` проверява).
- **`/clear` сменя session id**: днес табът пази първия → сесията изглежда „в друг терминал“, а „Премести тук“ и „Спри“
  (`stopSession` не намира таб с новия id) стигат до процеса в терминала на AgentDeck. „Прикачи вместо resume“ би го
  влошило (новият id няма `term` → втори resume). Мерки: relink (§4.8), resume защитата по `sessionId`, отказът в
  `takeOverSession`; остава прозорец ≤ 3 s.
- **`sessionRunning`**: днес хостът отказва само `sessions.stop`/`delete`; отказът за втори resume е само в UI-я
  (`renderer.js` `resume` пита за локална, за отдалечена не предлага). Сега и хостът (§4.4).
- **Командният център** е терминал на хоста като всеки друг: peer го вижда и може да го спре; връща се с
  `centre:start`. Не се отваря от хоста при рестарт (`skip`).
- **Стар desktop спира споделен терминал с X** (§6) – докато всички desktop-и не са обновени (автообновяването).
- **„Спри всички и излез“** спира и терминалите, които други гледат – потвърждението го казва.
- **Сигурност**: сдвоен desktop и досега пуска произволни команди тук (MESH.md §4) – да гледа и пише в чужд терминал
  не добавя права. Реле и ресурсен хост – нищо: заявките им се отказват, кадрите им не са в `ctl`.

---

## 8. Тестове

Остават зелени: `check`, `test:mesh`, `test:pairing`, `test:mesh-relay-only`, `test:mesh-proxy`, `test:host-pair`,
`test:web-link`, `test:web-hardening`, `test:phone-invites`, `test:relay`, `test:layout`, `test:devices`,
`test:audit`, `test:live`, `test:context`, `test:themes`, `test:bar-ui`, `scripts/test-workspace.js`,
`scripts/test-remote-state.js`. Променят се нарочно: `test:shared-terminals`, `test:mobile-provider`, `test:manager-ui`.

| Тест | Пакет | Какво |
|---|---|---|
| `scripts/test-terminal-viewers.js` (нов) | A | Чист `viewers.js` с фалшив backend: всеки ред на таблицата в §4.3; `HOLD`; hand-back по `inputAt`/`attachedAt`; случайни поредици от want/attach/detach от 3 зрители без input/take → `S` се сменя само при `D = null` (без ping-pong); `MAX_VIEWERS`; `isReport` – всеки автоматичен отговор на xterm.js 6 и никой клавиш, paste или мишка. |
| `scripts/test-shared-terminals.js` (пренаписан) | A | In-process H, D1, D2, P (както сега): D1 и D2 виждат всички; D2 се прикача и пише в терминала на D1 и в собствения на хоста; `viewers`/`driver` в `terminals` и `terminal.size` до всички зрители; resize от не-водач се пренебрегва, input го прави водач (след `HOLD`), `terminals.resize` take/release; link down → hand-back; `close` от D2 → D1 и P чуват `terminals` без него; `resume` на работеща → `already`; `tooManyViewers`; кадри от peer без заявка се пускат; `terminal.resync` с фалшив `links.buffered`; `live.list` носи `term`. DockPty + node-pty, както сега. |
| `scripts/test-host-restore.js` (нов) | A | node-pty (когато се зарежда): регистър, `detachAll` пази записите без `terminal:exit`, `restoreTerminals` отваря същите id (shell и „агент“ с фалшив `resumeCommand`), `skip`, граница. Windows: убит DockPty pid → същия id. |
| `tab-links` relink (в `test-terminal-viewers.js` или свой) | A | Свързан таб с мъртъв id + жива сесия във веригата → `link(…, { replace: true })`. |
| `scripts/test-desktop-terminals.js` (нов) | B | `src/desktop-terminals.js`: съставяне на view-то (локални + отдалечени, `paned`, `me`, `legacy`), разликата за `syncLocalViewers`, планът за възстановяване (§5.4 – всеки ред), маршрутът id → node. |
| `test:manager-ui` (разширен) | C | Fixture: заглавие със зрители и `stop`; X праща `close-pane` без диалог; Стоп пита и вика `terminals.stop`; чужд размер → чип + `fit` → `takeSize`; секция „Терминали“ (редове, „няма панел тук“, клик → `open-term`); „Агенти“ с `term` без панел → `open-term`. |
| `test:mobile-provider` (обновен) | D | „Нагоди“ = `terminals.resize`, обратно = release; при link down размерът се връща на зрителя „“ на хоста (want 100×30 през `host.viewers`) вместо `terminal:refit`; `live.term`; редовете носят зрителите. |

---

## 9. Работни пакети

Всички тръгват веднага срещу договорите в §4.7 и §5.3; сливане в `feat/shared-sessions` в реда **A → B → C → D**.
Интеграционните тестове на B и D минават чак след A; Electron fixture тестът на C не зависи от никого. Всеки пакет в
свой worktree от `feat/shared-sessions`.

**A – хост и протокол.** Цел: §4 изцяло.
- Притежава: `src/host/viewers.js` (нов), `src/host/index.js`, `src/host/terminals.js`, `src/host/terminals-pty.js`,
  `src/host/launch.js`, `src/host/tab-links.js`, `src/host/errors.js`, `src/mesh/serve.js`, `src/mesh/links.js`,
  `src/mesh/protocol.js`, `host/bin/agentdeck-host.js`, `scripts/test-shared-terminals.js`,
  `scripts/test-terminal-viewers.js`, `scripts/test-host-restore.js`; ред-препратка в `docs/MESH.md` §3 и
  `docs/MOBILE.md` §6 към този документ.
- Изпълнява: §4.1–4.8, API-то от §4.7 точно така.
- Не пипа: `src/main.js`, нищо в UI-я, `mobile/`, `src/i18n.js` (кодовете на грешките са в `errors.js`; текстовете –
  C и D), `scripts/test-mobile-provider.js`.

**B – desktop main.** Цел: §5.1–5.4, §5.6.
- Притежава: `src/main.js`, `src/desktop-terminals.js` (нов, чисти функции), `src/preload.js`, `src/workspace.js`,
  `src/orchestrator.js`, `scripts/test-desktop-terminals.js`, `scripts/test-workspace.js`.
- Ползва: §4.7 (до сливането на A – срещу заглушка със същите имена); изпълнява §5.3 за C.
- Не пипа: `src/host/`, `src/mesh/`, UI файловете, `src/i18n.js` (ползва само ключовете от §3.3; ако трябва нов – C
  го добавя).

**C – desktop UI.** Цел: §3.1, §3.3, §5.5.
- Притежава: `src/workspace-ui.js`, `src/renderer.js`, `src/nodes-ui.js`, `src/palette-ui.js`, `src/bar.js`,
  `src/index.html`, `src/styles.css`, `src/terminals.css`, `src/common.js` (иконата), `src/i18n.js`,
  `scripts/test-manager-ui-electron.cjs`, `scripts/test-bar-ui-electron.cjs`.
- Ползва: §5.3 (IPC и view-то) – в теста през fixture.
- Не пипа: `src/main.js`, `src/preload.js` (липсващ метод → към B, договорът се оправя тук), хоста, `mobile/`.

**D – телефон.** Цел: §3.2, телефонната част на §6.
- Притежава: `mobile/src/**` (`data.js`: `resize` → `terminals.resize` take/release при `info.terminals === 2`, иначе
  кадър; `termOf` първо `live.term`; зрителите в `tab`), `screens/terminal.js` (ред „и на:“, „Нагоди“/„Върни“),
  `mock.js`, `mobile/src/i18n.js`, `scripts/test-mobile-provider.js`.
- Ползва: §4.1–4.3.
- Не пипа: нищо извън `mobile/` и теста си.

Шевове: B↔C – само `preload.js` + view-то (§5.3), собственост на B; A↔B – §4.7; `common.js` – само C. Няма файл
с двама собственици.

---

## 10. Отворени въпроси

Решено (2026-11-11, пакет A): 1 – по препоръката (агенти и shell-ове, същия id, до 64, `reopened`); 2 – по препоръката
(без вдигане на протокола).

1. **Какво отваря хостът сам след рестарт?** Препоръка: агентите (resume) **и** shell-овете, със същия id, до 64,
   с бележка „Отворен отново след рестарт“ – shell-ът не струва нищо, а панелите му на всички устройства остават.
   Алтернатива: само агентите; shell-овете изчезват (и панелите им навсякъде).
2. **Стари desktop-и срещу нов хост спират споделения терминал с X** (§6). Препоръка: приемаме, без вдигане на
   протокола – desktop-ите се обновяват сами; вдигането би ги откъснало изцяло до обновяване.
