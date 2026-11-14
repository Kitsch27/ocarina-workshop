# 时之笛谱工坊

把五线谱或数字简谱转换成 Nintendo Switch 2《时之笛》重制版的陶笛按键谱。

打开网页后，选择乐谱并点击「识别并转谱」。支持常见图片、PDF 和 MusicXML。识谱和音符转换在访客的浏览器内运行。用「校对」检查音高和拍数，选择游戏里的按键布局，再试听、复制、下载 TXT 或导出 PNG 图片。较长的谱可分页保存为 PNG。

导出的谱按小节排列。`↑+A` 表示先按住十字键上，再按 A。`摇↓+A` 表示先向下推左摇杆，再按 A。`—` 表示休止，`×2` 表示两拍。谱尾附有生成谱子的网页链接。

「试用示例」载入《塞尔达摇篮曲》。点击按键谱里的音符选定起点，再点「试听」即可从那里播放。点击「回到开头」可恢复从头播放。

默认使用简易指法（C4–E5）。在标准按键布局中，每个音最多使用十字键或左摇杆其中一个，再加发音键。在「演奏设置 → 指法模式」选择「完整（允许组合）」，可使用两种升降音控制同时按住的指法（B3–F5）。自动移调和八度调整会按所选模式计算。

## 部署

把仓库根目录设为 GitHub Pages 的发布来源。在 **Settings → Pages** 里选择 **Deploy from a branch**，然后选择 `main` 和 `/(root)`。页面和识谱模型都已包含在仓库里。

## 素材与指法

陶笛图片来自任天堂官网，版式参考 Zelda Notes。这是玩家制作的工具。[任天堂官网](https://www.nintendo.com/es-es/Juegos/Juegos-de-Nintendo-Switch-2/The-Legend-of-Zelda-Ocarina-of-Time-3115664.html)

按键换算沿用玩家指法表的记谱八度。[LoZ Ocarina Note Charts](https://github.com/diacoviello/LoZ-Ocarina-Note-Charts#quick-reference)

网站页脚的「来源与识谱说明」列出了开源组件及各自的许可。

制作 · [Kitsch27](https://github.com/Kitsch27) 与 Codex。

Ocarina Workshop is an unofficial fan project, not affiliated with or endorsed by Nintendo. The Legend of Zelda and Ocarina of Time are trademarks of Nintendo.
