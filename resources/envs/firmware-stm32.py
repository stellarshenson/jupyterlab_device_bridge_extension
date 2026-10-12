#!/usr/bin/env -S PYTHONDONTWRITEBYTECODE=1 uv run --quiet --script
## Rust firmware toolchain for STM32 - compiler, Cortex-M libraries, binary tools, stm32flash
# /// script
# requires-python = ">=3.12"
# dependencies = ["rich>=13"]
# ///
"""Install the conda environment firmware-stm32: stable Rust with the library of every STM32 core,
the LLVM binary tools, and stm32flash for upload through the chip's serial bootloader."""

import shutil

from firmware_env import Stage, install

RUST = "1.99.0"
STM32FLASH = "0.7"
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
    env.rustup(RUST, "--component", "rust-src,llvm-tools,clippy,rustfmt", "--target", ",".join(TARGETS))


def cargo_binutils(env):
    """cargo objcopy, cargo size and the other front ends of the llvm-tools component."""
    env.run("cargo", "install", "--locked", "cargo-binutils")


def stm32flash(env):
    (archive,) = env.fetch(f"https://downloads.sourceforge.net/project/stm32flash/stm32flash-{STM32FLASH}.tar.gz")
    shutil.unpack_archive(archive, env.tmp, filter="data")
    env.run(
        "make", "install", f"PREFIX={env.prefix}",
        "CC=x86_64-conda-linux-gnu-gcc", "AR=x86_64-conda-linux-gnu-ar",
        cwd=env.tmp / f"stm32flash-{STM32FLASH}",
    )


install(
    name="firmware-stm32",
    summary="Rust firmware toolchain for STM32",
    stages=[
        Stage("C compiler, make, pyserial", "conda-forge", conda_packages),
        Stage(f"Rust {RUST} with {len(TARGETS)} Cortex-M targets", "static.rust-lang.org", rust),
        Stage("cargo-binutils", "crates.io", cargo_binutils),
        Stage(f"stm32flash {STM32FLASH}", "sourceforge.net", stm32flash),
    ],
    tools=[
        ("cargo", ["cargo", "--version"]),
        ("rustc", ["rustc", "--version"]),
        ("cargo objcopy", ["cargo", "objcopy", "--version"]),
        ("stm32flash", f"stm32flash {STM32FLASH}"),  # the program has no version option
        ("targets", "  ".join(TARGETS)),
    ],
    usage=[
        "conda activate firmware-stm32",
        "cargo build --release --target thumbv7em-none-eabihf",
        "cargo objcopy --release --target thumbv7em-none-eabihf -- -O binary firmware.bin",
        "stm32flash -w firmware.bin -v <serial device>",
    ],
)
