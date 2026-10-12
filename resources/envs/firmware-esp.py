#!/usr/bin/env -S PYTHONDONTWRITEBYTECODE=1 uv run --quiet --script
## Firmware toolchain for ESP32 (Rust) and ESP8266 (C/C++) - Espressif Rust, espflash, esptool, ESP8266 core
# /// script
# requires-python = ">=3.12"
# dependencies = ["rich>=13"]
# ///
"""Install the conda environment firmware-esp: Rust for every ESP32 chip, espflash and esptool for
upload over a serial port, and for the ESP8266, which Rust does not support, the C/C++ toolchain
with its SDK as the Arduino core."""

import shutil

from firmware_env import CONDA, Stage, install

# Espressif's project template selects the toolchain by the name "stable"; a version number here
# would make rustup download a second toolchain at the first build of such a project.
RUST = "stable"  # builds for the RISC-V chips: ESP32-C2, C3, C5, C6, C61, H2, P4
ESP_RUST = "1.97.0.0"  # Espressif's build of Rust, for the Xtensa chips: ESP32, S2, S3
ESPUP = "0.17.1"
ESPFLASH = "4.6.0"
ARDUINO_CLI = "1.5.1"
ESP8266_CORE = "3.1.2"
ESP8266_INDEX = "https://arduino.esp8266.com/stable/package_esp8266com_index.json"


def conda_packages(env):
    env.create("pyserial", "esptool")


def rust(env):
    env.rustup(RUST, "--component", "rust-src,clippy,rustfmt")


def espressif_rust(env):
    """espup adds the toolchain `esp` with its Xtensa GCC and LLVM library to the environment's
    rustup folder, and the RISC-V targets to the stable toolchain."""
    (espup,) = env.fetch(f"https://github.com/esp-rs/espup/releases/download/v{ESPUP}/espup-x86_64-unknown-linux-gnu")
    espup.chmod(0o755)
    env.run(
        espup, "install", "--targets", "all", "--toolchain-version", ESP_RUST, "--stable-version", RUST,
        "--export-file", env.tmp / "export-esp.sh",
    )
    # the two settings of espup's export file, made part of the environment's activation
    esp = env.prefix / "rustup/toolchains/esp"
    env.link(next(esp.glob("xtensa-esp-elf/*/xtensa-esp-elf/bin")))
    libclang = next(esp.glob("xtensa-esp32-elf-clang/*/esp-clang/lib"))
    env.run(CONDA, "env", "config", "vars", "set", "--name", env.name, f"LIBCLANG_PATH={libclang}")


def espflash(env):
    release = f"https://github.com/esp-rs/espflash/releases/download/v{ESPFLASH}"
    (archive,) = env.fetch(f"{release}/espflash-x86_64-unknown-linux-musl.zip")
    shutil.unpack_archive(archive, env.tmp)
    shutil.copy2(env.tmp / "espflash", env.prefix / "bin")
    (env.prefix / "bin/espflash").chmod(0o755)


def esp8266_core(env):
    """arduino-cli keeps the core, with xtensa-lx106-elf-gcc and the SDK, in <prefix>/arduino."""
    (archive,) = env.fetch(f"https://downloads.arduino.cc/arduino-cli/arduino-cli_{ARDUINO_CLI}_Linux_64bit.tar.gz")
    shutil.unpack_archive(archive, env.tmp / "arduino-cli", filter="data")
    shutil.copy2(env.tmp / "arduino-cli/arduino-cli", env.prefix / "bin")
    env.run("arduino-cli", "core", "update-index")
    env.run("arduino-cli", "core", "install", f"esp8266:esp8266@{ESP8266_CORE}")
    shutil.rmtree(env.prefix / "arduino/downloads")  # the installed core does not need its archives


install(
    name="firmware-esp",
    summary="Firmware toolchain for ESP32 and ESP8266",
    variables={
        "ARDUINO_DIRECTORIES_DATA": "{prefix}/arduino/data",
        "ARDUINO_DIRECTORIES_DOWNLOADS": "{prefix}/arduino/downloads",
        "ARDUINO_DIRECTORIES_USER": "{prefix}/arduino/user",
        "ARDUINO_BOARD_MANAGER_ADDITIONAL_URLS": ESP8266_INDEX,
    },
    stages=[
        Stage("C compiler, pyserial, esptool", "conda-forge", conda_packages),
        Stage(f"Rust {RUST}", "static.rust-lang.org", rust),
        Stage(f"Espressif Rust {ESP_RUST} for Xtensa", "github.com", espressif_rust),
        Stage(f"espflash {ESPFLASH}", "github.com", espflash),
        Stage(f"ESP8266 core {ESP8266_CORE} with arduino-cli", "downloads.arduino.cc", esp8266_core),
    ],
    tools=[
        ("cargo", ["cargo", "--version"]),
        ("cargo +esp", ["cargo", "+esp", "--version"]),
        ("xtensa gcc", ["xtensa-esp32-elf-gcc", "--version"]),
        ("espflash", ["espflash", "--version"]),
        ("esptool", ["esptool", "version"]),
        ("arduino-cli", ["arduino-cli", "version"]),
        ("ESP8266 core", f"esp8266:esp8266 {ESP8266_CORE} with xtensa-lx106-elf-gcc and the SDK"),
    ],
    usage=[
        "conda activate firmware-esp",
        "cargo build --release    (in an esp-hal project; its rust-toolchain.toml selects the compiler)",
        "espflash flash --monitor --port <serial device> <firmware>",
        "arduino-cli compile --fqbn esp8266:esp8266:nodemcuv2 <sketch folder>",
        "esptool --port <serial device> write-flash 0x0 <firmware>.bin",
    ],
)
