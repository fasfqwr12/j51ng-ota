# 02 · M 主控升级流程（目标 = M）

## 一句话

**上位机把镜像通过 BLE 发给 S 板，S 板先存到自己的暂存 flash，校验通过后按 1024 B 重新分包，经 UART 转发给主控，主控写进自己 APP 区、算 SHA、回报。**

## 流程图

```mermaid
flowchart TD
    A[上位机: 选 M 镜像 .hex/.bin<br/>算 SHA256 / 长度] --> B[BLE 连接 4B:AC:00:15:39:33<br/>服务 2760...1001]
    B --> C{设备在 APP?}
    C -->|是| C1[发 53 A2 04 00 FF 01 F9 01<br/>APP 写 PENDING 标志 + NVIC_SystemReset]
    C1 --> C2[S 板进 boot 并广播]
    C -->|否, 已在 boot| C2

    C2 --> D[0x0101 握手请求<br/>payload = 16B 硬件码 J51VA-M]
    D --> E[0x0102 应答<br/>含 maxpkt=228]
    E --> F[0x0201 参数<br/>size(4) + sha256(32) + pkt(2) = 38B]
    F --> G[S 板: 记录期望 SHA / 长度<br/>设置暂存区基址 0x01030000<br/>开始分片擦除暂存区]
    G --> H[0x0202 应答 status=0]
    H --> I[0x0301 数据包 ×N<br/>seq/total/len/data + CRC8]
    I --> J[S 板: 批量缓存 → 写暂存 flash<br/>每 8 包回一次 0x0302 ACK]
    J --> K{最后一包?}
    K -->|否| I
    K -->|是| L[S 板: 对暂存区实算 SHA256<br/>与 0x0201 期望值比对]

    L --> M[0x0401 SHA 请求<br/>payload 里带 SHA, 设备忽略]
    M --> N[0x0402 应答<br/>status=0 + 实算摘要]
    N --> O[S 板进入 APPLYING<br/>boot_main_upgrade_prepare]

    O --> P[UART: 0x1000 ENTER_BL<br/>让主控进 boot]
    P --> Q[主控回 0x1001 announce ready=1]
    Q --> R[UART: 0x1002 HANDSHAKE<br/>version + sha256]
    R --> S[UART: 0x1011 数据 ×102<br/>每包最多 1024B, 从暂存区顺序读]
    S --> T[主控: 累计偏移写 APP 区 0x08002800<br/>擦除/写入成功才回 0x1012 status=0]
    T --> U{全部收完?}
    U -->|否| S
    U -->|是| V[主控: BL_SHA256_Compute<br/>APP 区, final_image_size]
    V --> W[UART: 0x1021 status + 32B 摘要]
    W --> X{status?}
    X -->|0x00| Y[UART: 0xFF00 完成指令]
    X -->|0x11 SHA_FAIL| X1[S 板重试 / 上位机报错]

    Y --> Z[S 板: apply done ok=1<br/>回 BLE 0x0502=0x00]
    Z --> AA[主控: boot_data 更新 → 跳新 APP]
    Z --> AB[S 板: **留在 boot 继续广播**<br/>不复位, 不等重连]
```

## 逐跳时序（一次成功实测，插件链路）

| # | 方向 | 帧 / 动作 | 关键点 |
|---|---|---|---|
| 1 | 上位机→S | `0x0101` | 16 B 硬件码 `J51VA-M` |
| 2 | S→上位机 | `0x0102` | `maxpkt=228`；网页据此定 228 B/包 |
| 3 | 上位机→S | `0x0201` | `size + SHA256 + pkt` |
| 4 | S→上位机 | `0x0202` | **暂存区擦完才该发**（见文档 05） |
| 5 | 上位机→S | `0x0301` ×816 / ×458 | 128 B（插件）或 228 B（网页） |
| 6 | S→上位机 | `0x0302` | 批量 ACK；**全 ACK ≠ 全写对** |
| 7 | 上位机→S | `0x0401` | 带 SHA，设备忽略，用 0x0201 的值 |
| 8 | S→上位机 | `0x0402` | `status=0` + 暂存区实算摘要 |
| 9 | S→M | `0x1000` | 让主控进 boot |
| 10 | M→S | `0x1001` | 周期 announce，`ready=1` 才可发数据 |
| 11 | S→M | `0x1002` | 把期望 SHA 交给主控 |
| 12 | S→M | `0x1011` ×102 | **1024 B/包**，从暂存区按 `pkt_index*1024` 读 |
| 13 | M→S | `0x1012` | 逐包 `status=0` |
| 14 | M→S | `0x1021` | `status=0`=主控 SHA 通过；`0x11`=失败 |
| 15 | S→M | `0xFF00` | 完成 |
| 16 | S→上位机 | `0x0502` | `0x00` 成功 |

## M 侧三个必须对齐的量

```c
// m_boot/Template/main.c
packet_offset = written_offset;              // 累计，不是 seq*1024
written_offset += data_frame.data_size;      // 每包成功后才累加
final_image_size = written_offset;           // 最后一包直接用
BL_SHA256_Compute(APP_START_ADDRESS, final_image_size, calc);
```

- **写偏移**：累计值，改前用 `seq_id*1024` 推算，错一位全盘错位。
- **校验长度**：`final_image_size`，即实际写入总量。
- **ACK 真实性**：擦除或写入失败必须回 `OTA_STATUS_FLASH_ERR (0x23)`，绝不 ACK 成功。

## M 完成后副板为什么不复位

`boot_ble_upgrade_get_dispatch_target() == BOOT_FLASH_TARGET_SUB` 才复位。
M/雷达目标下 S 板固件没变，复位只会断链、逼上位机重连。

```c
// s_boot main.c:294
if (dispatch_target == SUB) break;          // 跳出 → 复位
boot_ble_upgrade_init(); continue;          // M: 原地重新待命
```

## 电源（M 侧）

`m_boot io_init()` 是 `main()` 第一条：

```
PD1 拉高 = 自保电
PA11 拉高 = 给蓝牙板供电
```

两者必须在任何跳转/复位前后都保持，否则整板掉到 ST-Link 漏电压。

## 成功判据

```
[3] 数据完成 … 重传 0
[4] SHA-256 匹配            ← 0x0402 status=0（S 板暂存区）
[M] RX 0x1021 status=0     ← 主控 APP 区 SHA
[5] 0x0502=0x00
总耗时 20~70 s
```
