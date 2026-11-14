# 时之笛谱工坊

把五线谱或数字简谱转换成 Nintendo Switch 2《时之笛》重制版的陶笛按键谱。

打开网页后，选择乐谱并点击「识别并转谱」。支持常见图片、PDF 和 MusicXML。识谱和音符转换在访客的浏览器内运行。用「校对」检查音高和拍数，选择游戏里的按键布局，再试听、复制、下载 TXT 或导出 PNG 图片。较长的谱可分页保存为 PNG。

点击「校对」后，可直接在按键谱中选择音符或休止符。修改演奏音高和拍数后点「保存」，也可用填好的值「在后面插入」、删除所选音符，或撤销上一处修改。音高下拉框和「试听可演奏音高」根据当前指法模式提供可用选项。「文本编辑」可修改曲名或整段原谱。

音频转谱为测试功能，识别效果仍在完善。上传 MP3、WAV 或 M4A 后，点击「提取旋律并转谱」。音频在浏览器内处理，每段最多 3 分钟、25 MB。建议使用独唱、口哨或单件乐器录音。音高和时值从录音估算，小节按时间分组，可在「校对」中编辑。

导出的谱按小节排列。`↑+A` 表示先按住十字键上，再按 A。`摇↓+A` 表示先向下推左摇杆，再按 A。`—` 表示休止，`×2` 表示两拍。谱尾附有生成谱子的网页链接。

「复制」和「下载 TXT」默认只保留按键顺序、小节和休止符。需要时值时可选「TXT（带拍数）」或导出 PNG。

「试用示例」载入《塞尔达摇篮曲》。点击按键谱里的音符选定起点，再点「试听」即可从那里播放。点击「回到开头」可恢复从头播放。

默认使用简易指法（C4–E5）。在标准按键布局中，每个音最多使用十字键或左摇杆其中一个，再加发音键。在「演奏设置 → 指法模式」选择「完整（允许组合）」，可使用两种升降音控制同时按住的指法（B3–F5）。自动移调和八度调整会按所选模式计算。

## 部署

把仓库根目录设为 GitHub Pages 的发布来源。在 **Settings → Pages** 里选择 **Deploy from a branch**，然后选择 `main` 和 `/(root)`。页面和识谱模型都已包含在仓库里。

## 离线使用

简谱识别组件随网站发布，首次识谱时下载。浏览器保留网站缓存时，之后打开同一网站可直接复用。

下载并解压项目 ZIP。打开终端，进入包含 `index.html` 的目录，运行下面的命令，再用浏览器打开 [本机工坊](http://127.0.0.1:8000/)。

    python -m http.server 8000 --bind 127.0.0.1

命令需要 Python 3。Windows 也可用 `py -3`，macOS 和 Linux 通常可用 `python3`。识谱模型随压缩包提供，解压后可断网识谱。启动服务的终端需保持打开。

[下载项目 ZIP](https://github.com/Kitsch27/ocarina-workshop/archive/refs/heads/main.zip)

简谱使用 Tesseract.js 的英语 LSTM 模型识别数字、符号和调号。精简版本保留原字形模型，移除了普通英文词典。更新原始组件后，运行 `node tools/pack-jianpu-ocr.mjs` 重新生成精简资源，并同步更新 `jianpu-ocr.mjs` 中的文件名或缓存版本与字节数。

## 素材与指法

陶笛图片来自任天堂官网，版式参考 Zelda Notes。这是玩家制作的工具。[任天堂官网](https://www.nintendo.com/es-es/Juegos/Juegos-de-Nintendo-Switch-2/The-Legend-of-Zelda-Ocarina-of-Time-3115664.html)

按键换算沿用玩家指法表的记谱八度。[LoZ Ocarina Note Charts](https://github.com/diacoviello/LoZ-Ocarina-Note-Charts#quick-reference)

网站页脚的「来源与识谱说明」列出了开源组件及各自的许可。

制作 · [Kitsch27](https://github.com/Kitsch27) 与 Codex。

Ocarina Workshop is an unofficial fan project, not affiliated with or endorsed by Nintendo. The Legend of Zelda and Ocarina of Time are trademarks of Nintendo.
