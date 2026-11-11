# 04 · APP ↔ Boot 模式切换、电源自保持、升级标志

## 模式判断（上位机侧，只读探测）

```
发 0x0101 握手
  ├─ 收到 0x0102 → 设备已在 BOOT，可直接升级
  └─ 无应答      → 设备在 APP，需要先发「进 Boot 命令」
```

> 上位机**不能**靠 GATT 服务是否存在来区分 boot/APP：两边用的是同一套
> `2760...1001 / 0001 / 0002`。Windows 曾因 GATT 缓存报
> `Characteristic ...0002 was not found`，那是缓存，不是设备没服务
> （插件已加 `winrt.use_cached_services=False`）。

## APP → Boot 命令

```
53 A2 04 00 FF 01 F9 01
│  │  │     │  └────── checksum 0x01F9 (LE) = sum(前 6 字节)
│  │  │     └───────── cmd 0xFF = enter bootloader
│  │  └─────────────── len = 4
│  └────────────────── header 0x53A2
```

`s_app/.../app_protocol.c` 收到后：

```c
write_boot_flag();                      // ① 写 PENDING 到 0x0100FF00
send_response(APP_CMD_BOOTLOADER,...);  // ② 回 0x54A1 ACK
delay_n_ms(200);                        // ③ 等 BLE TX 刷完
__disable_irq();
NVIC_SystemReset();                     // ④ 完整复位（中断随复位重建）
```

**为什么是完整复位而不是直接跳**：APP 里 `__disable_irq()` 后若直接跳 boot，
boot 的 USART0 接收中断永远进不来，收不到 `0x1000` 敲门，会形成
「APP→boot→立刻回 APP」死循环。

## 升级标志（S 板 boot_data 页 `0x0100FF00`）

| 字索引 | 偏移 | 含义 |
|---|---|---|
| 0 | `0x00` | magic `0x56414F54` ("VAOT") |
| 1 | `0x04` | layout version `0x00010003` |
| **2** | **`0x08`** | `upgrade_flag`：`0xFFFFFFFF`=NONE，`0x00000001`=PENDING |
| 3 | `0x0C` | app_program_end |
| 7 | `0x1C` | integrity magic `0x41505031` |

**必须先擦页再写**，否则 FMC 报 `PGERR(status=2)`，标志永远写不进去。

APP 里 `write_boot_flag()` 已经会 `Qflash_Erase_Sector(0x0100F000)` 再写。

## S boot 快速路径（决定复位后去哪）

```c
// s_boot main.c:194
boot_flash_read_boot_info();
g_dbg_fastpath = (boot_app_image_is_valid(APP_START)
                  && upgrade_flag != PENDING) ? 1 : 0;

if (g_dbg_fastpath) {
    boot_app_integrity_verify();   // CRC 不过 → 留在 boot 等升级
    jump_to_application(0x01010000);
}
// 否则：初始化 UART + BLE，停在 boot 广播
```

| flag | APP 合法 | 结果 |
|---|---|---|
| `0xFFFFFFFF` 或 NONE | 是 | 跳 APP |
| `PENDING=1` | 是/否 | **留 boot** |
| 任意 | 否（空/半包） | 留 boot |
| 任意，CRC 不过 | — | 留 boot |

> 曾踩坑：快路径原来只看「APP 是否合法」，合法就无条件跳走，
> 于是 APP 写了 PENDING 后复位又被跳回 APP，**永远进不了 boot**。已修。

## 电源自保持（最容易变砖的地方）

整板靠 GPIO 拉高维持供电。**任何模式切换都不能把这个脚拉低。**

| 芯片 | 函数 | 引脚 | 动作 |
|---|---|---|---|
| **M 主控** | `m_boot io_init()`（main 第一条） | `PD1` 自保电、`PA11` 蓝牙供电 | `GPIO_BOP` 全部置位拉高 |
| **S 蓝牙板 boot** | `power_gpio_init()`（main 第一条） | `PB1` POWER、`PB12` EN2 | `GPIO_SetBits` 拉高 |
| **S 蓝牙板 APP** | `Power_Gpio_Init()` | `PB1` POWER | `GPIO_SetBits` 拉高 |

**已修的历史 bug**：S APP 原来在这里调 `POWER_OFF()`，一跳到 APP 就断电，
整板掉到 ST-Link 漏电压 ~1.9V，表现为「不广播、SWD 拒绝复位」。
现在注释明确写了必须与 boot 一致拉高。

## 手动进 boot（调试用）

`E:\tof\xuRxuG\05_scripts\enter_boot.py`：

```
读 0x0100FF00 的 256 B → 把 word2 改成 1 → 擦该扇区 → 写回 → reset
```

> 需要 ST-Link 接在**蓝牙板**上；且同一时刻只能有一个 SWD 消费者
> （Keil 开着调试会占住）。

## 一个 BLE 中心原则

设备连上任意中心后就**不再广播**。因此：

- 桌面守护进程连着时，网页 / 手机扫不到
- 网页连着时，守护进程扫不到
- 这不是「守护进程占用 bug」，是 BLE 从机协议本分

排查「一会连上一会连不上」时，先确认**此刻到底有几个中心**，
以及**这段时间有没有在 SWD 擦写/复位**（擦写窗口里芯片被 halt，必然不广播）。

## 调试模式 / 量产模式

`s_boot/src/boot_log.h`：

```c
#define BOOT_LOG_MODE  0    // 0=量产静音（编译期消除，ROM 省 ~6.8KB）
                            // 1=调试（全量 [BL]/[MB] 日志走 BLE NTF）
```

| | 调试 | 量产 |
|---|---|---|
| S boot ROM | 39668 B | **32864 B** |
| RX/print | 大量 | **0 条** |
| 用途 | 定位竞态 | 交付 / 稳定性 |

M boot 已彻底关闭 `BOOT_UART_TRACE`（UART0 与主控协议共用一条线，printf 会抢线）。

**要排查时**：把 `BOOT_LOG_MODE` 改回 `1` 重编译烧录即可，协议逻辑一行不动。
