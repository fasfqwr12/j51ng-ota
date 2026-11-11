# 05 · 插件 vs 网页：差异、SHA 竞态、为什么「有时候管用」

## 先回答那个问题

> 「为什么自己写脚本就管用、用插件升级也管用？」

**网页脚本这次其实没管用**：数据层全通，但 `0x0402` 回 `0x11` = SHA 失败。
**插件成功过**（job-0002），但**也失败过**（job-0001 `0x1021 status=17`）。

所以准确说法是：**同一个竞态，两条链路命中概率不同**，不是「某个上位机对、另一个错」。

## 两条链路实测对照

| | 桌面插件 `ble_daemon.py` | 网页 `ota_web/src/app.js` |
|---|---|---|
| BLE 后端 | Python bleak / WinRT | Chrome Web Bluetooth |
| 连接 | 常驻守护进程 | 浏览器页 |
| 分包（M 104388 B） | **128 B × 816** | **228 B × 458** |
| 窗口 | `win=32` | `win=32` |
| 发包间隔 | **每 4 包 sleep 4 ms** | **每包 sleep 4 ms** |
| 单次 M 数据阶段 | ~8 s（816 包） | **7.5 s（458 包）** |
| `0x0201` 超时 | 10 s | 25 s |
| `0x0501` 超时 | 30 s / 2 s 重发 | 30 次 / 1.5 s |
| 成功记录 | ✅ `0x1021 status=0` → `0x0502=0x00` | ❌ `0x0402=0x11` |
| 失败记录 | ⚠️ 早前 `status=17` / 参数无应答 | ⚠️ 本次 SHA 失败 |

**协议、帧格式、CRC8、SHA256 两边完全一致**，差异只有**节奏**。

## 竞态根因（代码里可确证）

`s_boot/.../boot_ble_upgrade.c` 的两处配合出问题：

### A. 握手时只「登记」擦除范围，不立即擦

```c
// handle_handshake_request()
ctx.write_base_address = app_end;      // 0x01030000
s_erase_cursor = ctx.write_base_address;
s_erase_end    = BOOT_FLASH_END_ADDRESS;   // 只记范围
boot_ble_protocol_send_handshake_response(...);
```

### B. `process()` 擦除期间直接 return，不读任何 BLE 帧

```c
if (s_erase_cursor < s_erase_end) {
    boot_flash_erase_range(s_erase_cursor, step_end);   // 每拍擦 4KB
    s_erase_cursor = step_end;
    ...
    return BOOT_BLE_UPGRADE_RESULT_PENDING;              // ← 不取帧
}
if (!boot_ble_protocol_take_received_frame(&frame)) return PENDING;
```

### C. `handle_param_request()` 立刻回 `0x0202`

```c
boot_ble_protocol_send_param_response(OK);   // 上位机收到就开始灌 0x0301
ctx.state = RECEIVING;
```

**串起来就是**：

```
S 板还在分片擦暂存区（若干拍，每拍 4KB）
   ↑ 这期间 process() 不取帧
上位机已经收到 0x0202，开始 win=32 连续发 458 包
   → 数据帧堆在协议层 RX 环形缓冲
   → 缓冲溢出 / 帧被丢
   → 但 S 板的批量 ACK 仍按「收到过」补发
   → 上位机看到「458/458、0 重传」
   → 暂存区实际内容是旧的 / 缺的
   → 实算 SHA ≠ 0x0201 期望值 → 0x0402=0x11
```

**「全包 ACK、0 重传」不等于「全写对」** —— 这是本轮最重要的判据。

### 为什么插件更容易过

- 128 B × 816 包、每 4 包歇 4 ms → 数据流更慢更均匀
- `boot_main_uart_idle_hook()` 在 UART 等待空档里**额外跑一次** `boot_ble_module_process()`
- 擦除进度更容易追上写入

但一旦节奏偏一点（早前 `retrans=1` 那次），同样会 `status=17`。

## 三个 SHA 不一致的实测值（网页这次）

```
网页 0x0201 发的期望值   11a8f0f2…   （UI 显示也是它，网页自洽）
index.json 标注          dab28489…   （旧值，网页实际没用它）
S 板对暂存区实算         3c703926…   ← 0x0402 payload 里带回来的
```

`index.json` 的 `sha256` 与文件实际内容不符，属于**库元数据过期**，
但本轮失败与它无关（网页用 crypto.subtle 现场算的）。

## 已写但未烧的修复（冻结，待确认）

思路：**让主机在暂存区擦完之前拿不到 `0x0202`**，从时序上消除竞态。

| # | 改动 |
|---|---|
| 1 | `ctx.param_reply_pending` 标志，`reset_session()` 清零 |
| 2 | `handle_param_request()` 不再立刻发 OK，只置标志 |
| 3 | `erase done` 时补发 `0x0202=0x00` + `ble_flush_tx_ms(30)` |
| 4 | 擦除期间用新增 `boot_ble_protocol_peek_frame_type()` **只放行控制帧**（`0x0201` 会在这段到达），数据帧留在 RX 环里不消费 |
| 5 | 编译已通过：`Code=28120`，0 Error，ROM 33008/65536 |

> **这版尚未烧录。** 网页当前连着设备（唯一中心），烧录会断链并需要
> 重新做一次 Web Bluetooth 授权 chooser。

## 顺带记录：另一个已修的确定性缺陷

`m_boot` 原来**擦写失败仍回 `0x1012 status=0`**，且失败时擦当前页盲重试，
可能把前序数据一起擦掉。已改为任何失败立即 `0x23 FLASH_ERR`、不累加长度。

`s_boot` 的 UART 收帧原来**一个 burst 只取第一帧**（`0x1001` 广播 + `0x1012` ACK
同到时 ACK 被丢），已改为全 burst 消费 + 4 帧队列。

这两处是「全 ACK 但最后 SHA 失败」时**必须先查**的地方，不要先换校验算法。

## 排查顺序（写死，不再跳步）

1. 看 `0x0402 status`：`0x00` 还是 `0x11` → 区分 S 暂存区 / M APP 区
2. 看 `0x1021 status`：`0x00` 还是 `0x11`/`0x17` → 区分主控写入
3. 看数据阶段 `retrans` 与「全 ACK」
4. **全 ACK ≠ 全写对**：查 flash API 返回值、擦除与写入的先后
5. 查暂存区擦除是否早于第一包数据
6. 最后才怀疑 SHA 算法 / 镜像本身

## 网页侧待办（不影响固件逻辑）

| 项 | 状态 |
|---|---|
| `parseHex()` 空洞填 `0x00`（守护进程填 `0xFF`） | 当前固件无空洞，暂不影响；**隐患** |
| `index.json` 三个 SHA 全是旧值 | 需 `tools/gen_index.py` 重生成 |
| 线上 `app.js` ≠ 本地 `app.js`（31544 vs 32320 B） | 本地改动未部署 |
| 本地已加 `autoClosure()` / 自动复用连接 | 线上未部署 |
| 文案「约 10~20 s」 | 实测 M 约 70 s，偏乐观 |
