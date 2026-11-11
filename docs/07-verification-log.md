# 07 · 实机验证记录与判定标准

## 已成功的闭环（插件链路）

| 目标 | 记录 | 判据 |
|---|---|---|
| S 蓝牙板 ×5 连续 | 5/5 全绿 | 每轮 PENDING→复位→boot 连接→499 包→`0x0502=0x00`→复位→APP 广播 |
| S 蓝牙板（量产静音 boot） | job-0002 | 499/499、0 重传、`0x0502=0x00`；20:36 段 90 条 RX/proto、**0 条 RX/print** |
| M 主控 | job-0016 / job-0002 | 816/816、0 重传、`[M] RX 0x1021 status=0`、`0x0502=0x00` |

M 成功轨迹（调试模式日志）：

```
[M] TX 0x1000 ENTER_BL
[M] RX 0x1001 len=14
[M] TX 0x1002 HANDSHAKE
[M] RX 0x1012 seq=N status=0
[M] RX 0x1021 status=0        ← 主控 APP 区 SHA 通过
[MB>] t=FF00 len=1
[BL] apply done ok=1
[5] 完成应答 0x00
```

## 网页链路实测（本轮）

```
[1]  握手成功（BOOT / J51VA-S / ff.ff.ff.ff）
[1b] 分包 pkt=228 B × 458
[2]  参数已接受
[3]  数据完成 104420 B · 7.5 s · 重传 0
     ← 0x0402 len=33  11 3C 70 39 26 70 6C 94 …
❌  SHA-256 校验失败
```

结论：**数据层完全打通，卡在暂存区 SHA**。详见 `05-host-diff-and-race.md`。

## 判定标准（写死，照这个判）

### 一次成功必须同时满足

```
数据阶段：sent == total，retrans == 0
0x0402 status == 0x00                ← S 板暂存区 SHA
（M 目标）0x1021 status == 0x00      ← 主控 APP 区 SHA
0x0502 == 0x00                       ← 应用结果
S 目标：断开后重新广播且探针为 APP
M 目标：S 板保持连接、无需重连
```

### 卡点定位表

| 现象 | 卡在哪 | 下一查 |
|---|---|---|
| 扫不到 / `0002 not found` | BLE 中心占用或 Windows GATT 缓存 | 只留一个中心；插件已加 `use_cached_services=False` |
| `0x0101` 无 `0x0102` | 设备在 APP 或擦除阻塞 | 发进 Boot 命令；看分片擦除 |
| `0x0201` 无 `0x0202` | 应答被 SHA 计算/日志压住 | 先 flush 再 prepare |
| 数据卡某 seq | flash 写失败 / ACK 丢 | 看 NACK status |
| **全 ACK 但 `0x0402=0x11`** | **暂存区内容不对** | **先查擦除是否早于第一包、flash API 返回值** |
| `0x1021 status=0x11` | 主控写入错位/失败 | 查 `written_offset`、擦写失败是否仍 ACK |
| `0x0501` 无 `0x0502` | APPLYING 未结束 / 设备已复位 | 重发 0x0501；重连看是否已是新 APP |
| 复位后仍 boot | 标志没清 / 完整性 CRC 不过 | 查 boot_data 与 `boot_app_integrity_mark` |

### 三条铁律

1. **全 ACK ≠ 全写对**。ACK 必须只在 flash API 返回成功后发。
2. **校验范围必须显式**：`written == firmware_total_size` 断言后再比摘要。
3. **同一时刻只能有一个 BLE 中心**；SWD 擦写/复位窗口里设备必然不广播。

## 已修复并编译验证的缺陷（未全部重新实机）

| # | 缺陷 | 修复 | 状态 |
|---|---|---|---|
| 1 | M boot 写 flash 失败仍 ACK、擦页盲重试 | 失败即 `0x23`，不累加长度 | ✅ 已烧、已实机验证 `status=0` |
| 2 | S boot UART 一个 burst 只取第一帧 | 全 burst 消费 + 4 帧队列 + checksum | ✅ 已烧、已实机验证 0 重传 |
| 3 | S boot SHA 前无长度断言 | `written == firmware_total_size` | ✅ 已烧 |
| 4 | 0x0202 早于暂存区擦完 | 挂起到 `erase done`，擦除期间 peek 只放行控制帧 | ⚠️ **已编译通过（0 Error），未烧录** |
| 5 | 插件 Windows GATT 缓存 | `winrt={"use_cached_services": False}` | ✅ 已改、重启守护进程后一次连上 |
| 6 | S boot 日志刷屏 | `BOOT_LOG_MODE=0` 量产静音 | ✅ 已烧、已实机验证 0 条 print |
| 7 | M boot 8 KB 顶满 | 关 `BOOT_UART_TRACE`，ROM 7280/8192 | ✅ 已烧 |

## 尚未做

- 第 4 项烧录后的网页闭环复验（需要断链 → SWD 烧 → 网页重新授权 chooser）
- 「boot → 升级 → APP → 再进 boot → 再升级」的**网页端**连续闭环
- 中断 / 断电变砖测试（按用户要求**暂不做**）
- `index.json` 三个 SHA 重新生成、线上 `app.js` 与本地同步
- `parseHex()` 空洞填 `0xFF`（当前固件无空洞，属隐患）

## 环境注意事项

- ST-Link 接**蓝牙板**时才能读 `0x0100FF00`；读主控要换接主控
- Keil 开着调试会占 ST-Link；`connect_mode=under-reset` 可绕过部分占用
- 烧录前停 BLE 监听并杀守护进程，避免擦写窗口刷「未发现设备」
- `.c/.h/.uvprojx` 可能是 GB18030 + CRLF，用 Python `surrogateescape` 往返编辑
