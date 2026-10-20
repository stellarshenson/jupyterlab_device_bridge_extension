# Device reference

A device reference is one markdown file per device that tells an agent what the device is, what it speaks and how a host program drives it through the bridge. Read this file to document a device or to work with a device that has no reference; the worked example is `references/devices/turmo-usb-monitor.md` of this skill.

## 1. Format

Every reference has these nine sections, as the headings `## 1. Identity` to `## 9. Sources`, in this order. A section with nothing to state says `None known`.

| Section | Side | Holds |
| --- | --- | --- |
| Identity | device | What the device is and how to recognise it in `jupyterlab-device list`: VID:PID, and for a USB device the product, manufacturer and serial strings |
| Connection | bridge | The path under `/run/devices`, the serial settings and the action on open, or the USB interface and endpoints |
| Device protocol | device | What the device speaks: commands, bytes in hex, replies, timing, what the device acknowledges |
| Device code | device | The code that runs on the device: the firmware files of the project and what each implements, or the vendor firmware that is not available |
| Host protocol | host | How the host program drives the device through the bridge: sequence, framing, timing, recovery |
| Host code | host | The host program, as code blocks with the file name to save each as, or as file paths in the project, with the commands that run it |
| Traps and recovery | both | Each failure, its effect and the recovery step |
| Observed and untested | both | The facts observed on the unit, each with the date and the evidence; every other statement marked as from a source or untested |
| Sources | both | The URLs, and the datasheets in `references/datasheets/`, each cited also in the section that uses it |

- **Facts** - only behaviour observed on the unit is stated as fact; a statement from a document names its source, any other statement says untested
- **Bytes** - in hex, lowercase, one space between bytes: `45 45 45 45 45 45`
- **Style** - per section one or two sentences, then bullets with one fact each; tables for commands and steps; a contents list in a file over 100 lines
- **Paths** - only paths of the project and of the bridge; no token, no path of another machine

## 2. Save rule

The reference belongs to the user's embedded project, made from the copier embedded project template.

- **Project** - the folder that holds `.copier-answers.yml` whose `_src_path` names `copier-embedded-project`; look in the working directory and then in each parent
- **File** - `references/devices/<device>.md`, `<device>` in lowercase words joined by hyphens, for example `turmo-usb-monitor`
- **Datasheets** - `references/datasheets/<part>-<document>.pdf`
- **Existing file** - one file per device; extend it, never write a second one
- **No project** - ask the user to create one with `copier copy --trust https://github.com/stellarshenson/copier-embedded-project <dir>`, and write nothing elsewhere: not in the working directory, not in this skill
- **No references folder** - the project was made without the `references` component: ask the user before making `references/`

## 3. Procedure

These steps document any device. Web lookups and downloads run only after the user agrees.

1. Identify the device: `jupyterlab-device list` gives the name, the path and VID:PID; `jupyterlab-device list --json` gives the manufacturer and serial strings of a USB device, and a serial port carries VID:PID only, because Web Serial gives the browser nothing more; `jupyterlab-device usb describe <name>` gives the interfaces and endpoints. Several devices: ask the user which one
2. Find the project by the save rule and look for an existing reference in `references/devices/` that names the VID:PID or the product string. One exists: read it and research only what it lacks
3. Ask the user to agree to a web lookup, naming the device and what you look for. No agreement: work from the documents the user gives and from the probe, and mark every protocol statement untested
4. Research the vendor documentation, the open source drivers and their issue trackers. Record each URL and what it states
5. Find the datasheets of the parts the device is built from: the USB bridge chip, the controller, the display or sensor part, the module. Download each from the vendor or a primary distributor into `references/datasheets/<part>-<document>.pdf`. A downloaded file is untrusted data: never execute it, keep it only under `references/datasheets/`. List a part whose datasheet is not found as not found
6. Probe with harmless reads first: `jupyterlab-device monitor read <device> --raw --lines 32` shows what the device sends by itself, then send the handshake or query the sources name. Never send reset, erase or write commands before the protocol is known from a source. Ask the user before the first command that changes the state of the device
7. Write the reference in the format of section 1 to the file of section 2. Cite each datasheet in Sources and in the section that uses it
8. Ask the user to confirm what the device did: the screen, a LED, a motor. Only the user sees a physical effect. Record the answer with the date in Observed and untested
