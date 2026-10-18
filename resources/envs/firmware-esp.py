#!/usr/bin/env -S PYTHONDONTWRITEBYTECODE=1 uv run --quiet --script
## Firmware toolchain for ESP32 (Rust) and ESP8266 (C/C++) - Espressif Rust, espflash, esptool, PlatformIO with the ESP8266 core
# /// script
# requires-python = ">=3.12"
# dependencies = ["rich>=13"]
# ///
"""Install the conda environment firmware-esp: Rust for every ESP32 chip, espflash and esptool for
upload over a serial port, and for the ESP8266, which Rust does not support, PlatformIO with the
C/C++ toolchain and the Arduino core with its SDK. The ESP8266 RTOS SDK and ESP-IDF add FreeRTOS
for the ESP8266 and the ESP32."""

import hashlib
import shutil

from firmware_env import CONDA, Stage, install

# Espressif's project template selects the toolchain by the name "stable"; a version number here
# would make rustup download a second toolchain at the first build of such a project.
RUST = "stable"  # builds for the RISC-V chips: ESP32-C2, C3, C5, C6, C61, H2, P4
ESP_RUST = "1.97.0.0"  # Espressif's build of Rust, for the Xtensa chips: ESP32, S2, S3
ESPUP = "0.17.1"
ESPFLASH = "4.6.0"
PLATFORMIO = "6.2.0"
ESP8266 = "4.2.1"  # PlatformIO platform with the Arduino ESP8266 core 3.1.2; a project pins the same version
ESP32 = "7.1.3"  # PlatformIO platform with ESP-IDF, which carries FreeRTOS
PYTEST = "9.1.1"
QEMU = "esp-develop-9.2.2-20260417"  # Espressif's QEMU fork, the only emulator with an ESP32 machine
QEMU_ASSET = "qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-x86_64-linux-gnu.tar.xz"
QEMU_SHA256 = "0eecb2a34a5586c0e59110f77b9343b7b336e82fdb0e1a30e1dc1bab8a547e35"


def conda_packages(env):
    # Python 3.13: ESP-IDF's component manager needs pydantic-core, which has no wheel for 3.15
    env.create("python=3.13", "pyserial", "esptool")


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


def esp8266(env):
    """PlatformIO keeps the platform, xtensa-lx106-elf-gcc and the Arduino core with the SDK in
    <prefix>/platformio; mklittlefs and mkspiffs build file system images."""
    env.platformio(PLATFORMIO, f"espressif8266@{ESP8266}", "nodemcuv2", "tool-mklittlefs", "tool-mkspiffs")
    env.run(env.prefix / "bin/python", "-m", "pip", "install", f"pytest=={PYTEST}")


def esp8266_rtos(env):
    """the ESP8266 SDK based on FreeRTOS, next to the Arduino core; the same platform and toolchain
    serve both frameworks"""
    env.platformio(PLATFORMIO, f"espressif8266@{ESP8266}", "nodemcuv2", framework="esp8266-rtos-sdk")


def esp32_idf(env):
    """ESP-IDF for the classic ESP32; it carries FreeRTOS and its own xtensa-esp32 toolchain, which
    sits next to the ESP8266 toolchain"""
    env.platformio(PLATFORMIO, f"espressif32@{ESP32}", "esp32dev", framework="espidf")


def esp32_qemu(env):
    """Espressif's QEMU fork, the only emulator with an ESP32 machine.

    The release is the xtensa system emulator for x86_64 Linux; its SDL2, libslirp, pixman and
    libgcrypt dependencies come from conda. The fork has no rpath, so a launcher in bin puts the
    environment's lib folder on the loader path and starts the real binary; the simulator tier
    finds `qemu-system-xtensa` on PATH inside the environment."""
    env.run(
        CONDA, "install", "--yes", "--override-channels", "--channel", "conda-forge",
        "--prefix", env.prefix, "sdl2", "libslirp", "pixman", "libgcrypt",
    )
    base = f"https://github.com/espressif/qemu/releases/download/{QEMU}"
    (archive,) = env.fetch(f"{base}/{QEMU_ASSET}")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    if digest != QEMU_SHA256:
        raise RuntimeError(f"{QEMU_ASSET}: sha256 {digest} does not match the pinned {QEMU_SHA256}")
    destination = env.prefix / "opt" / "esp-qemu"
    shutil.rmtree(destination, ignore_errors=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.unpack_archive(archive, env.tmp)
    shutil.move(env.tmp / "qemu", destination)
    launcher = env.prefix / "bin" / "qemu-system-xtensa"
    launcher.write_text(
        "#!/bin/sh\n"
        'PREFIX=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\n'
        'QEMU="$PREFIX/opt/esp-qemu"\n'
        'LD_LIBRARY_PATH="$PREFIX/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"\n'
        "export LD_LIBRARY_PATH\n"
        'exec "$QEMU/bin/qemu-system-xtensa" "$@"\n'
    )
    launcher.chmod(0o755)


def circuit(env):
    """ngspice runs the netlist of the opt-in ltspice component in batch mode."""
    env.circuit_simulator()


install(
    name="firmware-esp",
    summary="Firmware toolchain for ESP32 and ESP8266",
    variables={"PLATFORMIO_CORE_DIR": "{prefix}/platformio"},
    stages=[
        Stage("C compiler, pyserial, esptool", "conda-forge", conda_packages),
        Stage(f"Rust {RUST}", "static.rust-lang.org", rust),
        Stage(f"Espressif Rust {ESP_RUST} for Xtensa", "github.com", espressif_rust),
        Stage(f"espflash {ESPFLASH}", "github.com", espflash),
        Stage(f"PlatformIO {PLATFORMIO}, espressif8266 {ESP8266}, pytest {PYTEST}", "registry.platformio.org", esp8266),
        Stage(f"FreeRTOS: ESP8266 RTOS SDK on espressif8266 {ESP8266}", "registry.platformio.org", esp8266_rtos),
        Stage(f"FreeRTOS: ESP-IDF on espressif32 {ESP32}", "registry.platformio.org", esp32_idf),
        Stage(f"Espressif QEMU {QEMU} with the ESP32 machine", "github.com", esp32_qemu),
        Stage("ngspice for the circuit simulation", "conda-forge", circuit),
    ],
    tools=[
        ("cargo", ["cargo", "--version"]),
        ("cargo +esp", ["cargo", "+esp", "--version"]),
        ("xtensa gcc", ["xtensa-esp32-elf-gcc", "--version"]),
        ("espflash", ["espflash", "--version"]),
        ("esptool", ["esptool", "version"]),
        ("pio", ["pio", "--version"]),
        ("PlatformIO espressif8266", f"{ESP8266} with the Arduino core 3.1.2 and the RTOS SDK"),
        ("PlatformIO espressif32", f"{ESP32} with ESP-IDF"),
        ("pytest", ["pytest", "--version"]),
        ("qemu-system-xtensa", ["qemu-system-xtensa", "--version"]),
        ("ngspice", ["ngspice", "--version"]),
    ],
    usage=[
        "conda activate firmware-esp",
        "cargo build --release    (in an esp-hal project; its rust-toolchain.toml selects the compiler)",
        "espflash flash --monitor --port <serial device> <firmware>",
        "pio run --target upload --upload-port <serial device>    (in a PlatformIO project)",
        "esptool --port <serial device> write-flash 0x0 <firmware>.bin",
        "qemu-system-xtensa -machine esp32 -nographic -drive file=<flash image>,if=mtd,format=raw    (ESP-IDF image; the simulator tier uses it)",
        "ngspice -b ltspice/circuit.cir    (the opt-in ltspice component runs the surrounding circuit)",
    ],
)
