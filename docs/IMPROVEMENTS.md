# Local improvements to AgentDeck

Ported from ClaudeDock and built on top of upstream `main`. All work is local, nothing is pushed. Each feature has
its own branch; `local/all-features` combines them with the fixes below and is the branch the app runs from.

## Features

| Feature | Where you see it | Branch |
|---|---|---|
| **"Needs you" state**: a Claude session blocked on a permission or a question is shown in rose, sorted first, and notified at once | Session cards, edge menu, project badges, the window title `(1!)` | `feature/needs-you-status` |
| **Context chip**: the context the agent last reported (tokens and share of the model's window, `≈` when the window is estimated), red once nearly full; "awaiting update" right after compaction or a model change | Every session card and edge-menu row; the tooltip names the model, the time of the report and the cache state when the agent reports it | `feature/context-chip` |
| **Recap**: where each session ended (its last answer, shortened) | "Край: …" line on session cards; also searchable | `feature/session-recap` |
| **Resume / Continue fresh**: Continue fresh opens a new session and puts a short handoff (task + where it ended) on the clipboard to paste, edit and send | Session preview (hover a card in the manager, or the edge menu's side pane) | `feature/continue-fresh` |
| **Terminals inside AgentDeck** (optional) and **Move here** for sessions running in Windows Terminal | Tray menu → *Open sessions in* → *AgentDeck tabs*. Default stays Windows Terminal; with no tabs open the window looks as before | `feature/terminal-tabs` |
| **Auto remember + compact**: big sessions in AgentDeck tabs get `/remember:remember` then `/compact` after a finished turn, while the cache is warm | Tray menu → *Big sessions in AgentDeck tabs* (on/off, 100k–300k). The tab shows "Remembering…" / "Compacting…" | `feature/auto-compact` |

## Fixes and performance (`fix/live-refresh-and-search`)

- **The list was not always current; search missed things.** The list is now rescanned by itself when transcripts
  change (at most every 5 s), so new sessions, titles, recaps and finished sessions show up without Refresh. The
  manager's search now also finds text inside the conversations (before, only the edge menu did).
- **Performance.** A rescan used to read every transcript in full (here 222 MB, about 1 s, blocking the app); now
  it reads only the lines added since the last scan (about 1 ms when nothing changed). Codex transcripts are read
  only at their head and cached; OpenCode 2 sessions are read from SQLite, with model limits cached separately; git status runs on full scans (start, Refresh);
  unchanged results are not re-sent to the windows; the search index updates at once for new sessions and at
  most every minute for growing ones.
- **Independent code review, fixed:** AgentDeck tabs no longer drop your own `CLAUDE_CODE_*` settings; Move here
  can no longer stop unrelated processes that carry a recycled process id; terminals no longer stay running when
  AgentDeck is killed; the autopilot stops at once when you type and skips a command that does not start; a tab
  is linked to its session through the process chain (not by folder and time); terminal output is no longer
  copied on every chunk; an interrupted bridge build cannot leave a broken exe; naming and layout follow the
  coding rules; terminal colours come from `theme.css`.

## Known limits

- A new Claude session in a tab is linked to the tab after its first prompt (Claude registers only then).
- Continue fresh uses the clipboard, also in tab mode.
- Not tried with real use yet: Move here on a running session, auto-compact on a real big session.

## See it in git

```
git log --oneline main..local/all-features
git branch --list "feature/*" "fix/*" "local/*"
```
