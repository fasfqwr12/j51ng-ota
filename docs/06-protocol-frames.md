# 06 · 协议帧参考表

## BLE 层（上位机 ↔ S 蓝牙板）

服务 `00002760-08c2-11e1-9073-0e8ac72e1001`
- write char `...0001`：boot 支持 `write` + `write-without-response`，APP 仅 `write-without-response`
- notify char `...0002`

### 帧格式

```
EB 90 | type(2, BE) | len(2, BE) | payload[N] | CRC8(1)
```

CRC8 = CRC-8/MAXIM，poly `0x07`，init 0，逐字节 `crc ^= b` 后左移 8 位。
校验范围 = `type + len + payload`（不含 EB90 头）。

### 帧类型

| type | 方向 | 名称 | payload |
|---|---|---|---|
| `0x0000` | S→上位机 | BEACON / KEEPALIVE | 空，`EB 90 00 00 00 00 00` |
| `0x0101` | 上位机→S | 握手请求 | 16 B 硬件码 `J51VA-M` / `J51VA-S` / `J51VA-R`，余下填 `0xFF` |
| `0x0102` | S→上位机 | 握手应答 | status(1) + hw(16) + version(4) + maxpkt(2, BE @21) |
| `0x0201` | 上位机→S | 参数请求 | size(4, BE) + SHA256(32) + pkt(2, BE) = 38 B |
| `0x0202` | S→上位机 | 参数应答 | status(1) |
| `0x0301` | 上位机→S | 数据 | seq(2) + total(2) + len(2) + data[M] |
| `0x0302` | S→上位机 | ACK | status(1) + seq(2) |
| `0x0303` | S→上位机 | NACK | status(1) + seq(2)（要求从该 seq 重发） |
| `0x0401` | 上位机→S | SHA 请求 | 32 B SHA（**设备忽略**，用 0x0201 的值） |
| `0x0402` | S→上位机 | SHA 应答 | status(1) + 32 B 暂存区实算摘要 |
| `0x0501` | 上位机→S | 完成请求 | 空，需重发（APPLYING 期间不消费） |
| `0x0502` | S→上位机 | **完成应答** | status(1)：`0x00` 成功，`0xFF` apply 失败 |
| `0x0601`/`0x0602`/`0x0603` | 上位机→S | 主控调试 | enterBL / raw / 命令应答 |
| `0x0604`/`0x0605` | 上位机→S | 读主控串口 | 请求 / len(2)+原始字节 |

### Status（BLE 层）

| 值 | 含义 |
|---|---|
| `0x00` | OK |
| `0x11` | SHA256_FAIL |
| `0x21` | SEQ_ERR |
| `0x22` | LEN_ERR |
| `0x23` | FLASH_ERR |
| `0xFF` | apply 超时 / 失败 |

## UART 层（S 板 ↔ M 主控）

同一帧头 `EB 90`，同一 CRC8，共用一条 UART（**PC 的 CH340 必须拔掉**）。

| type | 方向 | 名称 | payload |
|---|---|---|---|
| `0x1000` | S→M | ENTER_BL | 1 B trigger |
| `0x1001` | M→S | announce / ready | version(4) + maxpkt(2) + ready(1) = 7 B，每 50 ms 广播 |
| `0x1002` | S→M | HANDSHAKE | version(4) + sha256(32) = 36 B |
| `0x1011` | S→M | 数据 | seq(2) + total(2) + len(2) + data[≤1024] |
| `0x1012` | M→S | 数据 ACK | status(1) + seq(2) = 3 B |
| `0x1021` | M→S | SHA 结果 | status(1) + sha256(32) = 33 B |
| `0xFF00` | S→M | 完成 | status(1) |

### UART 侧 Status

| 值 | 含义 |
|---|---|
| `0x00` | OK |
| `0x11` | SHA_FAIL（主控 APP 区 SHA 不匹配） |
| `0x21` | SEQ_ERR |
| `0x22` | LEN_ERR |
| `0x23` | FLASH_ERR（擦/写失败） |

> 历史日志里的 `status=17` 是十进制，即 `0x11` = SHA_FAIL。

## 分包尺寸（容易混淆）

| 层 | 尺寸 | 谁决定 |
|---|---|---|
| BLE 数据帧（插件） | 128 B | 上位机 |
| BLE 数据帧（网页） | 228 B | `min(231, 0x0102 的 maxpkt) & ~3` |
| S 板写暂存区 | 批量 4 KB | `BOOT_BLE_DATA_BATCH_PKTS=17` |
| UART `0x1011` | **1024 B** | `BOOT_MAIN_PROTOCOL_MAX_DATA_SIZE` |
| M 主控写 flash | 累计偏移 | `written_offset += data_size` |

**BLE 分包与 UART 分包互不相关**：S 板把暂存区按 1024 B 重新读出再转发。

## APP 层进 Boot 命令

```
53 A2 04 00 FF 01 F9 01
```
header `0x53A2`、len 4、cmd `0xFF`、参数 `0x01`、checksum `0x01F9`(LE) = sum(前 6 字节)。
应答 `0x54A1`。
