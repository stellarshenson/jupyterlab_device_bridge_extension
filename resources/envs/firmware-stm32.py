#!/usr/bin/env -S PYTHONDONTWRITEBYTECODE=1 uv run --quiet --script
## Rust firmware toolchain for STM32 - compiler, Cortex-M libraries, binary tools, rust-analyzer, stm32flash
# /// script
# requires-python = ">=3.12"
# dependencies = ["rich>=13"]
# ///
"""Install the conda environment firmware-stm32: stable Rust with the library of every STM32 core,
the LLVM binary tools, rust-analyzer for the editor, PlatformIO with the ststm32 platform and both
STM32 frameworks, QEMU and ngspice for the simulator tiers, and stm32flash for upload through the
chip's serial bootloader."""

import shutil

from firmware_env import Stage, install

RUST = "1.99.0"
STM32FLASH = "0.7"
PLATFORMIO = "6.2.0"
STSTM32 = "20.0.0"
PYTEST = "9.1.1"
QEMU = "11.1.2"  # the ARM system emulator; netduinoplus2 carries an STM32F405
QEMU_URL = f"https://download.qemu.org/qemu-{QEMU}.tar.xz"
QEMU_SHA256 = "731b5681e4bb18be313231579b8efd0296c5b015fa36dc533874b639ba838016"
TARGETS = [
    "thumbv6m-none-eabi",  # Cortex-M0, M0+ - STM32F0, G0, L0, C0, U0
    "thumbv7m-none-eabi",  # Cortex-M3 - STM32F1, F2, L1
    "thumbv7em-none-eabi",  # Cortex-M4, M7 without the floating-point unit
    "thumbv7em-none-eabihf",  # Cortex-M4, M7 - STM32F3, F4, F7, G4, H7, L4, WB
    "thumbv8m.main-none-eabi",  # Cortex-M33 without the floating-point unit
    "thumbv8m.main-none-eabihf",  # Cortex-M33 - STM32L5, U5, H5, WBA
]


def conda_packages(env):
    env.create("make", "pyserial")  # make builds stm32flash in the last stage


def rust(env):
    env.rustup(RUST, "--component", "rust-src,llvm-tools,clippy,rustfmt,rust-analyzer", "--target", ",".join(TARGETS))


def cargo_binutils(env):
    """cargo objcopy, cargo size and the other front ends of the llvm-tools component."""
    env.run("cargo", "install", "--locked", "cargo-binutils")


def platformio(env):
    """One platform, two frameworks: the STM32Cube HAL and the Arduino core. The same environment
    serves the Rust and the PlatformIO branches of a project; each call installs the platform's
    toolchain and the framework of its board, and the second call reuses the platform."""
    env.platformio(PLATFORMIO, f"ststm32@{STSTM32}", "genericSTM32F405RG", framework="stm32cube")
    env.platformio(PLATFORMIO, f"ststm32@{STSTM32}", "bluepill_f103c8", framework="arduino")
    env.run(env.prefix / "bin/python", "-m", "pip", "install", f"pytest=={PYTEST}")


def stm32flash(env):
    (archive,) = env.fetch(f"https://downloads.sourceforge.net/project/stm32flash/stm32flash-{STM32FLASH}.tar.gz")
    shutil.unpack_archive(archive, env.tmp, filter="data")
    env.run(
        "make", "install", f"PREFIX={env.prefix}",
        "CC=x86_64-conda-linux-gnu-gcc", "AR=x86_64-conda-linux-gnu-ar",
        cwd=env.tmp / f"stm32flash-{STM32FLASH}",
    )


def qemu(env):
    """The ARM system emulator with the netduinoplus2 machine, which carries an STM32F405."""
    env.qemu_system(QEMU, QEMU_URL, QEMU_SHA256, "arm-softmmu", "netduinoplus2")


def circuit(env):
    """ngspice runs the netlist of the opt-in ltspice component in batch mode."""
    env.circuit_simulator()


install(
    name="firmware-stm32",
    summary="Rust and PlatformIO firmware toolchain for STM32",
    variables={"PLATFORMIO_CORE_DIR": "{prefix}/platformio"},
    stages=[
        Stage("C compiler, make, pyserial", "conda-forge", conda_packages),
        Stage(f"Rust {RUST} with {len(TARGETS)} Cortex-M targets", "static.rust-lang.org", rust),
        Stage("cargo-binutils", "crates.io", cargo_binutils),
        Stage(f"PlatformIO {PLATFORMIO}, ststm32 {STSTM32}, STM32Cube and Arduino, pytest {PYTEST}", "registry.platformio.org", platformio),
        Stage(f"stm32flash {STM32FLASH}", "sourceforge.net", stm32flash),
        Stage(f"QEMU {QEMU} with the netduinoplus2 machine", "download.qemu.org", qemu),
        Stage("ngspice for the circuit simulation", "conda-forge", circuit),
    ],
    tools=[
        ("cargo", ["cargo", "--version"]),
        ("rustc", ["rustc", "--version"]),
        ("rust-analyzer", ["rust-analyzer", "--version"]),
        ("cargo objcopy", ["cargo", "objcopy", "--version"]),
        ("pio", ["pio", "--version"]),
        ("PlatformIO platform", f"ststm32 {STSTM32} with STM32Cube and Arduino"),
        ("pytest", ["pytest", "--version"]),
        ("stm32flash", f"stm32flash {STM32FLASH}"),  # the program has no version option
        ("qemu-system-arm", ["qemu-system-arm", "--version"]),
        ("ngspice", ["ngspice", "--version"]),
        ("targets", "  ".join(TARGETS)),
    ],
    usage=[
        "conda activate firmware-stm32",
        "cargo build --release --target thumbv7em-none-eabihf",
        "cargo objcopy --release --target thumbv7em-none-eabihf -- -O binary firmware.bin",
        "stm32flash -w firmware.bin -v <serial device>",
        "pio run    (in a PlatformIO project; the platform and framework come from platformio.ini)",
        "qemu-system-arm -machine netduinoplus2 -display none -serial null -serial stdio -kernel <firmware.elf>    (the simulator tier uses it)",
        "ngspice -b ltspice/circuit.cir    (the opt-in ltspice component runs the surrounding circuit)",
    ],
)
