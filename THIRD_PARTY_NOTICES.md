# Third-party notices

## Colour themes

AgentDeck's colour themes in `src/themes.css` are adapted from the VS Code themes below: their published colours
(editor, sidebar, widgets, borders, foreground, accent and terminal ANSI colours) are placed on AgentDeck's own
interface tokens, with small changes for readability noted in that file. AgentDeck's own Dark, Light and Black themes
are not derived from them.

| Theme in AgentDeck | Upstream theme | Copyright | Licence | Source |
| --- | --- | --- | --- | --- |
| One Dark Pro | One Dark Pro | Copyright (c) 2013-2022 Binaryify | MIT | https://github.com/Binaryify/OneDark-Pro |
| Dracula | Dracula for Visual Studio Code | Copyright (c) 2016 Dracula Theme | MIT | https://github.com/dracula/visual-studio-code |
| GitHub Dark | GitHub Theme (GitHub Dark Default) | Copyright (c) 2020 Primer | MIT | https://github.com/primer/github-vscode-theme |
| Tokyo Night | Tokyo Night | Copyright (c) 2018-present Enkia | MIT | https://github.com/enkia/tokyo-night-vscode-theme |
| Catppuccin Mocha | Catppuccin for VSCode / Catppuccin palette | Copyright (c) 2021 Catppuccin | MIT | https://github.com/catppuccin/vscode, https://github.com/catppuccin/palette |
| Night Owl | Night Owl | Copyright (c) 2018 Sarah Drasner | MIT | https://github.com/sdras/night-owl-vscode-theme |
| Nord | Nord Visual Studio Code | Copyright (c) 2016-present Sven Greb | MIT | https://github.com/nordtheme/visual-studio-code |
| Ayu Mirage | ayu (Ayu Mirage) | Copyright (c) 2016 Ike Kurghinyan | MIT | https://github.com/ayu-theme/vscode-ayu |
| Gruvbox Dark | Gruvbox Theme (Gruvbox Dark Medium) | Copyright © 2017 JD | MIT | https://github.com/jdinhify/vscode-theme-gruvbox |
| Solarized Dark | Solarized Dark, as shipped in VS Code; the Solarized palette | Copyright (c) 2015 - present Microsoft Corporation; Copyright (c) 2011 Ethan Schoonover | MIT | https://github.com/microsoft/vscode/tree/main/extensions/theme-solarized-dark, https://github.com/altercation/solarized |
| One Light | One Light (One Dark Pro) | Copyright (c) 2013-2022 Binaryify | MIT | https://github.com/Binaryify/OneDark-Pro |
| Tokyo Night Light | Tokyo Night (Tokyo Night Light) | Copyright (c) 2018-present Enkia | MIT | https://github.com/enkia/tokyo-night-vscode-theme |
| Light Owl | Night Owl (Night Owl Light) | Copyright (c) 2018 Sarah Drasner | MIT | https://github.com/sdras/night-owl-vscode-theme |
| Ayu Light | ayu (Ayu Light) | Copyright (c) 2016 Ike Kurghinyan | MIT | https://github.com/ayu-theme/vscode-ayu |
| Catppuccin Latte | Catppuccin for VSCode / Catppuccin palette | Copyright (c) 2021 Catppuccin | MIT | https://github.com/catppuccin/vscode, https://github.com/catppuccin/palette |
| Solarized Light | Solarized Light, as shipped in VS Code; the Solarized palette | Copyright (c) 2015 - present Microsoft Corporation; Copyright (c) 2011 Ethan Schoonover | MIT | https://github.com/microsoft/vscode/tree/main/extensions/theme-solarized-light, https://github.com/altercation/solarized |

Each of the works above is distributed under the MIT License:

```
MIT License

Copyright (c) <year> <copyright holders, as listed above>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## QR code encoder

The QR code of Settings → Computers → Phones → "Add phone" (`src/voice/ui/settings-nodes.js`) is made by
qrcode-generator, loaded from `node_modules/qrcode-generator/dist/qrcode.js` and run unchanged, on the computer itself.

| Used for | Upstream | Copyright | Licence | Source |
| --- | --- | --- | --- | --- |
| The phone pairing QR code | qrcode-generator 2.0.4 | Copyright (c) 2009 Kazuhiko Arase | MIT | https://github.com/kazuhikoarase/qrcode-generator |

It is distributed under the MIT License, whose text is the one above (with the copyright holder listed here).

The word "QR Code" is a registered trademark of DENSO WAVE INCORPORATED.
