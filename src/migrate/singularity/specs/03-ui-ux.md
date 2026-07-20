# 03 — UI/UX

## Goal

Create a professional, theme-aware DAW interface that feels native to VS Code while supporting flexible tab layouts.

## Tab model

Each major DAW component is a separate VS Code webview tab. The user can drag tabs anywhere.

| Tab | Purpose | Default location |
|---|---|---|
| **Timeline** | Custom editor for `.vsdaw`. Main composition surface. | Editor group where file was opened |
| **Mixer** | Channel strips, faders, pans, meters, inserts. | Bottom panel |
| **Piano Roll** | MIDI note editor. | Right editor group |
| **Browser** | Devices and workspace samples. | Left sidebar |
| **Graph** | Optional node-based routing view. | Bottom panel / right group |

## Shared UI chrome

Every view tab has a lightweight toolbar:

- Transport: play/pause, stop, record, loop toggle, metronome toggle.
- Time display: current position in bars/beats/ticks and hours/minutes/seconds.
- Project name and save status indicator.
- Overflow menu: show/hide other tabs, settings, export.

## Timeline view

- Canvas-based multi-track timeline.
- Track headers on the left: name, color, mute/solo/arm buttons, volume fader, pan knob.
- Main canvas: time ruler, regions/clips, playhead, loop markers, zoom/pan.
- Right-click context menus for track and region operations.
- Drag-and-drop audio from Browser or file explorer onto tracks.

## Mixer view

- Vertical channel strips per track + master strip.
- Controls per strip: meter, fader, pan knob, mute/solo/arm, insert slots.
- Resizable strips, horizontal scroll.
- Double-click an insert slot to open the device parameter panel.

## Piano Roll view

- Grid with piano keys on the left.
- Add/move/resize/delete notes.
- Velocity lane and optional CC lanes.
- Snap modes: off, 1/4 beat, 1/2 beat, beat, bar.

## Browser view

- Tree sections:
  - **Devices**: OpenDAW stock devices categorized (Instruments, Effects, Utilities).
  - **Workspace Samples**: folders from the active workspace.
  - **Project Samples**: samples already imported into the current project.
- Preview on hover/click.
- Drag-and-drop into timeline or insert slots.

## Theming

- All UI colors derive from VS Code CSS variables (`--vscode-editor-background`, `--vscode-foreground`, etc.).
- Accent colors use `--vscode-button-background`.
- Canvas rendering samples theme colors and applies opacity for tracks/regions.

## Keyboard shortcuts

Default keybindings (user-configurable):

| Action | Keybinding |
|---|---|
| Play/Pause | `Space` |
| Stop | `Cmd/Ctrl+1` |
| Record | `Cmd/Ctrl+R` |
| Toggle Loop | `Cmd/Ctrl+L` |
| Undo | `Cmd/Ctrl+Z` |
| Redo | `Cmd/Ctrl+Shift+Z` |
| Delete selection | `Delete` / `Backspace` |
| Duplicate | `Cmd/Ctrl+D` |
| Show Mixer | `Cmd/Ctrl+Shift+M` |
| Show Browser | `Cmd/Ctrl+Shift+B` |
| Export | `Cmd/Ctrl+Shift+E` |

## Animations

- Use Framer Motion sparingly for panel entrances, tab transitions, and button feedback.
- Avoid motion that could conflict with low-latency audio timing.

## Accessibility

- All interactive controls have `aria-label`.
- Keyboard navigation between tracks and regions.
- Focus-visible outlines using VS Code theme colors.

## Acceptance criteria

1. UI renders correctly in both dark and light VS Code themes.
2. Tabs can be moved, split, and closed like native editor tabs.
3. Transport controls respond within 16 ms visually.
4. All listed keyboard shortcuts are registered and functional.
