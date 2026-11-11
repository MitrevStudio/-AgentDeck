// UI strings (Bulgarian and English) and locale-aware formatting for the phone app. The same idea as the desktop's
// src/i18n.js - flat dotted keys, t(key, {vars}), tn(key, n) with Intl.PluralRules - but its own table: the app
// shows a small part of what the desktop does and words some of it for a phone. The language follows the phone's.

const STRINGS = {
  en: {
    "app.name": "AgentDeck",
    "common.back": "Back",
    "common.cancel": "Cancel",
    "common.open": "Open",
    "common.you": "You",
    "common.search": "Search",

    "nav.inbox": "Sessions",
    "nav.new": "New",
    "nav.computers": "Computers",

    "pair.tagline": "The sessions on your computers, from your phone.",
    "pair.scan": "Scan the code from AgentDeck",
    "pair.scanHint": "On the computer: Settings → Computers → Phones → Add a phone",
    "pair.or": "or by hand",
    "pair.paste": "Paste the code's text",
    "pair.pastePh": "AGENTDECK-PAIR:…",
    "pair.pair": "Pair",
    "pair.manual": "Without a code from AgentDeck",
    "pair.relay": "Address of the relay (or of a computer)",
    "pair.relayPh": "192.168.1.10:7421",
    "pair.code": "Its code",
    "pair.codePh": "the relay's long code (agentdeck-host pair) or a computer's six digits",
    "pair.connect": "Connect",
    "pair.demo": "Demo",
    "pair.demoHint": "Look around with sample computers and sessions",
    "pair.diag": "Connection check",
    "pair.badInput": "Give the address with its port and the code.",
    "pair.badAddress": "Give the address with its port, e.g. 192.168.1.10:7421",
    "pair.notCode": "Not an AgentDeck pairing code: {why}",
    "pair.connecting": "Pairing with {addr}…",
    "pair.addTitle": "Add computers",
    "pair.name": "This phone's name",
    "pair.nameHint": "The computers list the phone under this name.",

    "pairing.title": "Pairing",
    "pairing.pending": "pairing…",
    "pairing.paired": "paired",
    "pairing.already": "already paired",
    "pairing.failed": "not paired: {reason}",
    "pairing.done": "{ok} of {all} paired",
    "pairing.none": "Nothing was paired.",
    "pairing.continue": "Continue",
    "pairing.again": "Try another code",
    "pairing.kind.relay": "relay",
    "pairing.kind.desktop": "AgentDeck",
    "pairing.kind.host": "headless host",

    "routes.title": "Computers behind {name}",
    "routes.hint": "Each computer pairs with its own code: an AgentDeck with its six digits (Settings → Computers), a headless host with its long code (agentdeck-host pair).",
    "routes.none": "The relay does not reach any computer right now.",
    "routes.waiting": "Waiting for the relay…",
    "routes.codePh": "6 digits",
    "routes.codePhHost": "long code",
    "routes.codeFor": "The code of {name}",
    "routes.paired": "paired",
    "routes.outdated": "needs an AgentDeck update",
    "routes.done": "Done",
    "routes.ok": "{name} paired",

    "scan.title": "Scan the code",
    "scan.hint": "Point the camera at the QR code in AgentDeck",
    "scan.starting": "Starting the camera…",
    "scan.noCamera": "No camera here, or no access to it. Allow the camera, or pair by hand.",
    "scan.insecure": "The camera needs a secure page (the app, or localhost in a browser).",
    "scan.found": "Code read",

    "inbox.title": "Sessions",
    "inbox.searchPh": "Session, project or computer",
    "inbox.waiting": "Waiting for you",
    "inbox.working": "Running",
    "inbox.recent": "Recent",
    "inbox.empty": "No sessions yet",
    "inbox.noMatch": "Nothing matches “{q}”",
    "inbox.offline": "{name} is offline",
    "inbox.demo": "Demo data",
    "inbox.terminals": "Terminals",

    "terms.title": "Terminals",
    "terms.byPhone": "from this phone",
    "terms.byHere": "opened there",
    "terms.byPeer": "from {name}",
    "terms.byOther": "from another device",
    "terms.exited": "ended",
    "terms.lost": "lost",
    "terms.close": "Close {title}",
    "terms.removeAsk": "Remove “{title}” from the list on {name}? It has ended already.",
    "terms.closed": "Terminal closed",
    "terms.none": "No terminals on {name}.",

    "node.newShell": "New terminal in the home folder",
    "node.offline": "{name} is offline: its terminals show once it is connected.",

    "status.waiting": "Needs you",
    "status.busy": "Working",
    "status.idle": "Ready",
    "status.other": "Running",
    "status.stopped": "Stopped",
    "status.reasonUnknown": "a question or a permission",

    "session.noMessages": "No messages to show",
    "session.firstPrompt": "First prompt",
    "session.more": "Older messages are on the computer",
    "session.replyPh": "Reply…",
    "session.send": "Send",
    "session.stop": "Stop",
    "session.stopAsk": "Stop “{title}”? The agent ends; the session can be resumed later.",
    "session.stopped": "Stopped",
    "session.terminal": "Terminal",
    "session.resume": "Resume",
    "session.resumed": "Resumed on {name}",
    "session.noTerm": "Not running in an AgentDeck terminal: it can be watched and stopped, not written to.",
    "session.noTermWatch": "Not running in an AgentDeck terminal: it can only be watched from here; stop it where it runs.",
    "session.notRunning": "Not running. Resume it to continue.",
    "session.offline": "The computer is offline",
    "session.sent": "Sent",
    "session.loading": "Loading…",
    "session.model": "Model {model}",
    "session.prompts.one": "{n} prompt",
    "session.prompts.other": "{n} prompts",
    "session.replies.one": "{n} reply",
    "session.replies.other": "{n} replies",
    "session.busy": "The agent is working, so the reply was not sent. It is still in the box.",
    "session.typeAnyway": "Type it into the terminal",
    "session.typed": "Typed into the terminal",
    "session.kept": "No connection to the computer: the reply stays here until it is back.",
    "session.noPreview": "Update AgentDeck on {name} to see the messages here.",
    "session.stopAskTerm": "Stop “{title}”? Its terminal on {name} is closed and the agent ends with it; the session can be resumed later.",
    "session.shell": "Terminal in this folder",

    "term.fit": "Fit to phone",
    "term.unfit": "Give the size back",
    "term.reconnecting": "Connection lost – reconnecting…",
    "term.gone": "This terminal is no longer there",
    "term.zoomFit": "Whole width",
    "term.zoomRead": "Readable size",
    "term.hostSize": "Host size {cols}×{rows}",
    "term.keyboard": "Keyboard",
    "term.close": "Close the terminal",

    "key.strip": "Keys for the terminal",
    "key.enter": "Enter",
    "key.tab": "Tab",
    "key.up": "Arrow up",
    "key.down": "Arrow down",
    "key.left": "Arrow left",
    "key.right": "Arrow right",
    "term.closeAsk": "Close this terminal on {name}? Whatever runs in it ends.",
    "term.exited": "The process has ended",
    "term.fitted": "Resized to {cols}×{rows}",
    "term.keptRunning": "The terminal keeps running: it is listed under Terminals.",

    "new.title": "New session",
    "new.computer": "Computer",
    "new.project": "Project",
    "new.agent": "Agent",
    "new.prompt": "Task",
    "new.promptPh": "What should the agent do? (optional)",
    "new.shell": "Terminal",
    "new.start": "Start",
    "new.started": "Started on {name}",
    "new.resumeTitle": "Or resume one",
    "new.noProjects": "No projects on this computer",
    "new.noComputers": "No computer is online",

    "computers.title": "Computers",
    "computers.online": "online",
    "computers.offline": "offline",
    "computers.lastSeen": "last seen {when}",
    "computers.via": "through {via}",
    "computers.direct": "connected directly",
    "computers.connecting": "connecting…",
    "computers.relayNote": "serves no sessions; the computers are reached through it",
    "computers.add": "Add computers: paste a code or type an address",
    "computers.scan": "Scan a code from AgentDeck",
    "computers.addBehind": "Pair a computer behind {name}",
    "computers.phone": "This phone",
    "computers.rename": "Rename",
    "computers.renamed": "The computers will see “{name}”",
    "computers.insecure": "Browser preview: the key is kept in localStorage – for development only, not secure.",
    "computers.secure": "The phone's key is kept in the Android Keystore.",
    "computers.unpairAsk": "Unpair this phone? Every computer that is online is told to forget it, and the phone's key is deleted.",
    "computers.forget": "Forget",
    "computers.forgetName": "Forget {name}",
    "computers.forgetAsk": "Forget {name}? It will have to be paired again.",
    "computers.forgotten": "{name} forgotten",
    "computers.kind.desktop": "AgentDeck",
    "computers.kind.headless": "headless host",
    "computers.kind.relay": "relay",
    "computers.sessions.one": "{n} session running",
    "computers.sessions.other": "{n} sessions running",
    "computers.terminals.one": "{n} terminal",
    "computers.terminals.other": "{n} terminals",
    "computers.demo": "You are looking at sample data.",
    "computers.leaveDemo": "Leave the demo",
    "computers.diag": "Connection check",
    "computers.notConnected": "No computer is connected.",
    "computers.unpair": "Unpair this phone",

    "conn.down": "No connection to {name}",
    "conn.downWhy": "{reason} Trying again…",
    "conn.connecting": "Connecting to {name}…",
    "conn.retry": "Try now",
    "conn.noRelay": "No relay – add one",
    "conn.noRelayWhy": "Nothing is left to reach your computers through: scan a code from AgentDeck, or add a relay by its address.",

    "diag.title": "Connection check",
    "diag.hint": "Opens a plain WebSocket from this app to the address, to see that ws:// to an IP gets through.",
    "diag.addr": "Address",
    "diag.try": "Try",
    "diag.trying": "Connecting to {url}…",
    "diag.ok": "Connected in {ms} ms",
    "diag.okClosed": "The server closed it (code {code})",
    "diag.fail": "Failed after {ms} ms (code {code})",
    "diag.timeout": "No answer in {s} s",
    "diag.bad": "Not a ws:// or wss:// address",
    "diag.message": "Received: {text}",
    "diag.env": "Page {origin} · secure context: {secure}",

    "banner.waiting": "{title} needs you",
    "toast.failed": "Failed: {error}",
    "err.notImplemented": "Not available",
    "err.offline": "The computer is offline.",
    "err.wrongCode": "The code is wrong.",
    "err.inviteExpired": "The code was used already or is older than 10 minutes – make a new one.",
    "err.wrongKey": "Another computer answered at that address than the one in the code.",
    "err.wrongNode": "Another computer answered there.",
    "err.nodeOutdated": "AgentDeck on that computer (or on the relay) needs an update.",
    "err.appOutdated": "This app needs an update for that computer.",
    "err.pairLater": "Too many tries – wait a moment and try again.",
    "err.pairBusy": "That computer is pairing with someone else – try again in a moment.",
    "err.pairUnproven": "The computer did not prove it knows the code.",
    "err.unreachable": "Not reachable.",
    "err.timeout": "No answer in time.",
    "err.closed": "The connection closed.",
    "err.handshake": "The secure connection could not be set up.",
    "err.unpaired": "That computer does not know this phone any more – pair it again.",
    "err.noHub": "No way to reach it – pair it again.",
    "err.invalidData": "Invalid data.",
    "err.relayOnly": "That is a relay: it serves no sessions.",
    "err.unknownMethod": "AgentDeck on that computer is too old for this – update it.",
    "err.notAllowed": "Not allowed.",
    "err.agentNotReady": "The agent is not ready for input.",
    "err.agentStopped": "The agent stopped before the message went in.",
    "err.terminalTooOld": "That terminal was started by an older AgentDeck – reopen it there.",
    "err.invalidSession": "Invalid session.",
    "err.stopUnsupported": "Only Claude sessions can be stopped from here.",
    "err.stopFailed": "The session could not be stopped.",
    "err.folderMissing": "The folder does not exist.",
    "err.unknownAgent": "Unknown agent.",
    "err.sessionRunning": "The session is already open in a terminal.",
    "err.storeFailed": "The phone's secure storage failed.",

    "time.justNow": "just now",
    "time.none": "no date"
  },

  bg: {
    "app.name": "AgentDeck",
    "common.back": "Назад",
    "common.cancel": "Отказ",
    "common.open": "Отвори",
    "common.you": "Ти",
    "common.search": "Търси",

    "nav.inbox": "Сесии",
    "nav.new": "Нова",
    "nav.computers": "Компютри",

    "pair.tagline": "Сесиите на компютрите ти – от телефона.",
    "pair.scan": "Сканирай кода от AgentDeck",
    "pair.scanHint": "На компютъра: Настройки → Компютри → Телефони → Добави телефон",
    "pair.or": "или ръчно",
    "pair.paste": "Постави текста на кода",
    "pair.pastePh": "AGENTDECK-PAIR:…",
    "pair.pair": "Сдвои",
    "pair.manual": "Без код от AgentDeck",
    "pair.relay": "Адрес на релея (или на компютър)",
    "pair.relayPh": "192.168.1.10:7421",
    "pair.code": "Кодът му",
    "pair.codePh": "дългият код на релея (agentdeck-host pair) или шестте цифри на компютър",
    "pair.connect": "Свържи",
    "pair.demo": "Демо",
    "pair.demoHint": "Разгледай с примерни компютри и сесии",
    "pair.diag": "Проверка на връзката",
    "pair.badInput": "Дай адреса с порта и кода.",
    "pair.badAddress": "Дай адреса с порта, напр. 192.168.1.10:7421",
    "pair.notCode": "Не е код за сдвояване от AgentDeck: {why}",
    "pair.connecting": "Сдвоявам се с {addr}…",
    "pair.addTitle": "Добави компютри",
    "pair.name": "Име на телефона",
    "pair.nameHint": "Под това име компютрите показват телефона.",

    "pairing.title": "Сдвояване",
    "pairing.pending": "сдвоявам…",
    "pairing.paired": "сдвоен",
    "pairing.already": "вече е сдвоен",
    "pairing.failed": "не е сдвоен: {reason}",
    "pairing.done": "Сдвоени {ok} от {all}",
    "pairing.none": "Нищо не беше сдвоено.",
    "pairing.continue": "Продължи",
    "pairing.again": "Опитай с друг код",
    "pairing.kind.relay": "релей",
    "pairing.kind.desktop": "AgentDeck",
    "pairing.kind.host": "хост без екран",

    "routes.title": "Компютри зад {name}",
    "routes.hint": "Всеки компютър се сдвоява със свой код: AgentDeck – с шестте си цифри (Настройки → Компютри), хост без екран – с дългия си код (agentdeck-host pair).",
    "routes.none": "В момента релеят не стига до никой компютър.",
    "routes.waiting": "Чакам релея…",
    "routes.codePh": "6 цифри",
    "routes.codePhHost": "дълъг код",
    "routes.codeFor": "Кодът на {name}",
    "routes.paired": "сдвоен",
    "routes.outdated": "трябва да се обнови AgentDeck",
    "routes.done": "Готово",
    "routes.ok": "{name} е сдвоен",

    "scan.title": "Сканирай кода",
    "scan.hint": "Насочи камерата към QR кода в AgentDeck",
    "scan.starting": "Пускам камерата…",
    "scan.noCamera": "Няма камера или достъп до нея. Разреши камерата или сдвои ръчно.",
    "scan.insecure": "Камерата иска защитена страница (приложението или localhost в браузър).",
    "scan.found": "Кодът е прочетен",

    "inbox.title": "Сесии",
    "inbox.searchPh": "Сесия, проект или компютър",
    "inbox.waiting": "Чака те",
    "inbox.working": "Работят",
    "inbox.recent": "Последни",
    "inbox.empty": "Още няма сесии",
    "inbox.noMatch": "Нищо за „{q}“",
    "inbox.offline": "{name} е офлайн",
    "inbox.demo": "Примерни данни",
    "inbox.terminals": "Терминали",

    "terms.title": "Терминали",
    "terms.byPhone": "от този телефон",
    "terms.byHere": "отворен там",
    "terms.byPeer": "от {name}",
    "terms.byOther": "от друго устройство",
    "terms.exited": "приключил",
    "terms.lost": "изгубен",
    "terms.close": "Затвори {title}",
    "terms.removeAsk": "Да махна ли „{title}“ от списъка на {name}? Вече е приключил.",
    "terms.closed": "Терминалът е затворен",
    "terms.none": "Няма терминали на {name}.",

    "node.newShell": "Нов терминал в домашната папка",
    "node.offline": "{name} е офлайн: терминалите му ще се покажат, когато се свърже.",

    "status.waiting": "Нужен си",
    "status.busy": "Работи",
    "status.idle": "Готова",
    "status.other": "Върви",
    "status.stopped": "Спряна",
    "status.reasonUnknown": "въпрос или разрешение",

    "session.noMessages": "Няма съобщения за показване",
    "session.firstPrompt": "Първа задача",
    "session.more": "По-старите съобщения са на компютъра",
    "session.replyPh": "Отговор…",
    "session.send": "Прати",
    "session.stop": "Спри",
    "session.stopAsk": "Да спра ли „{title}“? Агентът спира; сесията може да продължи после.",
    "session.stopped": "Спряна",
    "session.terminal": "Терминал",
    "session.resume": "Продължи",
    "session.resumed": "Продължава на {name}",
    "session.noTerm": "Не върви в AgentDeck терминал: може само да се гледа и спира, не и да ѝ се пише.",
    "session.noTermWatch": "Не върви в AgentDeck терминал: оттук може само да се гледа; спира се там, където върви.",
    "session.notRunning": "Не върви. Продължи я, за да ѝ пишеш.",
    "session.offline": "Компютърът е офлайн",
    "session.sent": "Пратено",
    "session.loading": "Зареждам…",
    "session.model": "Модел {model}",
    "session.prompts.one": "{n} задача",
    "session.prompts.other": "{n} задачи",
    "session.replies.one": "{n} отговор",
    "session.replies.other": "{n} отговора",
    "session.busy": "Агентът работи, затова отговорът не е пратен. Още е в полето.",
    "session.typeAnyway": "Напиши го в терминала",
    "session.typed": "Написано в терминала",
    "session.kept": "Няма връзка с компютъра: отговорът стои тук, докато се върне.",
    "session.noPreview": "Обнови AgentDeck на {name}, за да виждаш съобщенията тук.",
    "session.stopAskTerm": "Да спра ли „{title}“? Терминалът ѝ на {name} се затваря и агентът спира с него; сесията може да продължи после.",
    "session.shell": "Терминал в тази папка",

    "term.fit": "Нагоди към телефона",
    "term.unfit": "Върни размера",
    "term.reconnecting": "Връзката прекъсна – свързвам се пак…",
    "term.gone": "Този терминал вече го няма",
    "term.zoomFit": "Цялата ширина",
    "term.zoomRead": "Четим размер",
    "term.hostSize": "Размер на хоста {cols}×{rows}",
    "term.keyboard": "Клавиатура",
    "term.close": "Затвори терминала",

    "key.strip": "Клавиши за терминала",
    "key.enter": "Enter",
    "key.tab": "Tab",
    "key.up": "Стрелка нагоре",
    "key.down": "Стрелка надолу",
    "key.left": "Стрелка наляво",
    "key.right": "Стрелка надясно",
    "term.closeAsk": "Да затворя ли терминала на {name}? Каквото върви в него, спира.",
    "term.exited": "Процесът приключи",
    "term.fitted": "Преоразмерен на {cols}×{rows}",
    "term.keptRunning": "Терминалът продължава да върви: ще го намериш под „Терминали“.",

    "new.title": "Нова сесия",
    "new.computer": "Компютър",
    "new.project": "Проект",
    "new.agent": "Агент",
    "new.prompt": "Задача",
    "new.promptPh": "Какво да направи агентът? (по желание)",
    "new.shell": "Терминал",
    "new.start": "Пусни",
    "new.started": "Пусната на {name}",
    "new.resumeTitle": "Или продължи стара",
    "new.noProjects": "Няма проекти на този компютър",
    "new.noComputers": "Няма компютър онлайн",

    "computers.title": "Компютри",
    "computers.online": "онлайн",
    "computers.offline": "офлайн",
    "computers.lastSeen": "последно {when}",
    "computers.via": "през {via}",
    "computers.direct": "свързан пряко",
    "computers.connecting": "свързвам се…",
    "computers.relayNote": "не сервира сесии; през него се стига до компютрите",
    "computers.add": "Добави компютри: постави код или въведи адрес",
    "computers.scan": "Сканирай код от AgentDeck",
    "computers.addBehind": "Сдвои компютър зад {name}",
    "computers.phone": "Този телефон",
    "computers.rename": "Преименувай",
    "computers.renamed": "Компютрите ще виждат „{name}“",
    "computers.insecure": "Преглед в браузър: ключът е в localStorage – само за разработка, не е защитен.",
    "computers.secure": "Ключът на телефона е в Android Keystore.",
    "computers.unpairAsk": "Да отвържа ли телефона? Всеки компютър онлайн ще го забрави, а ключът на телефона се изтрива.",
    "computers.forget": "Забрави",
    "computers.forgetName": "Забрави {name}",
    "computers.forgetAsk": "Да забравя ли {name}? Ще трябва да се сдвои наново.",
    "computers.forgotten": "{name} е забравен",
    "computers.kind.desktop": "AgentDeck",
    "computers.kind.headless": "хост без екран",
    "computers.kind.relay": "релей",
    "computers.sessions.one": "{n} сесия върви",
    "computers.sessions.other": "{n} сесии вървят",
    "computers.terminals.one": "{n} терминал",
    "computers.terminals.other": "{n} терминала",
    "computers.demo": "Гледаш примерни данни.",
    "computers.leaveDemo": "Излез от демото",
    "computers.diag": "Проверка на връзката",
    "computers.notConnected": "Няма свързан компютър.",
    "computers.unpair": "Отвържи телефона",

    "conn.down": "Няма връзка с {name}",
    "conn.downWhy": "{reason} Опитвам пак…",
    "conn.connecting": "Свързвам се с {name}…",
    "conn.retry": "Опитай сега",
    "conn.noRelay": "Няма релей – добави",
    "conn.noRelayWhy": "Не остана през какво да стигна до компютрите ти: сканирай код от AgentDeck или добави релей по адрес.",

    "diag.title": "Проверка на връзката",
    "diag.hint": "Отваря обикновен WebSocket от приложението до адреса – да се види, че ws:// до IP минава.",
    "diag.addr": "Адрес",
    "diag.try": "Опитай",
    "diag.trying": "Свързвам се с {url}…",
    "diag.ok": "Свързано за {ms} ms",
    "diag.okClosed": "Сървърът затвори (код {code})",
    "diag.fail": "Неуспех след {ms} ms (код {code})",
    "diag.timeout": "Няма отговор за {s} s",
    "diag.bad": "Не е ws:// или wss:// адрес",
    "diag.message": "Получено: {text}",
    "diag.env": "Страница {origin} · защитен контекст: {secure}",

    "banner.waiting": "{title} те чака",
    "toast.failed": "Неуспех: {error}",
    "err.notImplemented": "Не е налично",
    "err.offline": "Компютърът е офлайн.",
    "err.wrongCode": "Кодът е грешен.",
    "err.inviteExpired": "Кодът вече е използван или е по-стар от 10 минути – направи нов.",
    "err.wrongKey": "На този адрес отговори друг компютър, не този от кода.",
    "err.wrongNode": "Там отговори друг компютър.",
    "err.nodeOutdated": "AgentDeck на този компютър (или на релея) трябва да се обнови.",
    "err.appOutdated": "Приложението трябва да се обнови за този компютър.",
    "err.pairLater": "Твърде много опити – изчакай малко и опитай пак.",
    "err.pairBusy": "Компютърът се сдвоява с друг – опитай след малко.",
    "err.pairUnproven": "Компютърът не доказа, че знае кода.",
    "err.unreachable": "Не се достига.",
    "err.timeout": "Няма отговор навреме.",
    "err.closed": "Връзката се затвори.",
    "err.handshake": "Защитената връзка не се установи.",
    "err.unpaired": "Компютърът вече не познава този телефон – сдвои го пак.",
    "err.noHub": "Няма как да се стигне до него – сдвои го пак.",
    "err.invalidData": "Невалидни данни.",
    "err.relayOnly": "Това е релей: не сервира сесии.",
    "err.unknownMethod": "AgentDeck на този компютър е твърде стар за това – обнови го.",
    "err.notAllowed": "Не е разрешено.",
    "err.agentNotReady": "Агентът не е готов да приема.",
    "err.agentStopped": "Агентът спря, преди съобщението да влезе.",
    "err.terminalTooOld": "Терминалът е пуснат от по-стар AgentDeck – отвори го наново там.",
    "err.invalidSession": "Невалидна сесия.",
    "err.stopUnsupported": "Оттук могат да се спират само сесии на Claude.",
    "err.stopFailed": "Сесията не можа да се спре.",
    "err.folderMissing": "Папката не съществува.",
    "err.unknownAgent": "Непознат агент.",
    "err.sessionRunning": "Сесията вече е отворена в терминал.",
    "err.storeFailed": "Защитеното хранилище на телефона даде грешка.",

    "time.justNow": "току-що",
    "time.none": "без дата"
  }
};

const LOCALES = { en: "en-GB", bg: "bg-BG" };

// The phone's language: Bulgarian when it is among the preferred ones before English, else English.
function detect() {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language || "en"];
  for (const l of langs) {
    const code = String(l).slice(0, 2).toLowerCase();
    if (STRINGS[code]) return code;
  }
  return "en";
}

let lang = detect();
const cache = new Map();

export function setLanguage(next) {
  if (STRINGS[next]) { lang = next; cache.clear(); }
  document.documentElement.lang = lang;
  return lang;
}
export const language = () => lang;

function lookup(key) {
  return STRINGS[lang][key] ?? STRINGS.en[key] ?? null;
}
const fill = (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s);

// t("banner.waiting", { title }) - placeholders are filled in as given: escape what goes into HTML.
export const t = (key, vars) => fill(lookup(key) ?? key, vars);

// An error as the user reads it: the translated text of its code (a host's, a link's or a pairing's), else its
// message. Also takes a bare code.
export function errorText(e) {
  const code = typeof e === "string" ? e : e?.code;
  if (code && lookup(`err.${code}`) != null) return t(`err.${code}`);
  return typeof e === "string" ? e : e?.message || String(e);
}

function intl(kind, opts) {
  const id = `${kind}|${JSON.stringify(opts || {})}`;
  if (!cache.has(id)) cache.set(id, new Intl[kind](LOCALES[lang], opts));
  return cache.get(id);
}
export const formatNumber = (n, opts) => intl("NumberFormat", opts).format(n);

export function tn(key, n, vars) {
  const form = intl("PluralRules").select(n);
  const s = lookup(`${key}.${form}`) ?? lookup(`${key}.other`) ?? key;
  return fill(s, { ...vars, n: formatNumber(n) });
}

// "3 minutes ago", as the desktop's ago().
export function ago(ms) {
  if (!ms) return t("time.none");
  const sec = (ms - Date.now()) / 1000, abs = Math.abs(sec);
  const rel = (v, unit) => intl("RelativeTimeFormat", { numeric: "auto" }).format(v, unit);
  if (abs < 45) return t("time.justNow");
  if (abs < 3600) return rel(Math.round(sec / 60), "minute");
  if (abs < 86400) return rel(Math.round(sec / 3600), "hour");
  if (abs < 7 * 86400) return rel(Math.round(sec / 86400), "day");
  return new Date(ms).toLocaleDateString(LOCALES[lang], { day: "numeric", month: "short" });
}
export const formatTime = ms => new Date(ms).toLocaleTimeString(LOCALES[lang], { hour: "2-digit", minute: "2-digit" });

// Static text in templates: data-i18n (text), data-i18n-placeholder, data-i18n-aria-label.
export function applyI18n(root = document) {
  for (const el of root.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll("[data-i18n-placeholder]")) el.placeholder = t(el.dataset.i18nPlaceholder);
  for (const el of root.querySelectorAll("[data-i18n-aria-label]")) el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
}
