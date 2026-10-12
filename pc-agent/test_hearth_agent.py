"""Tests for the Hearth PC agent. Run: python -m unittest test_hearth_agent.py"""

import json
import tempfile
import time
import unittest
from pathlib import Path

import hearth_agent as agent

RETROARCH = "11111111-1111-1111-1111-111111111111"


def write_launchbox(root: Path, games_per_platform: int, favourite_every: int) -> None:
    (root / "Data" / "Platforms").mkdir(parents=True)
    (root / "Data" / "Emulators.xml").write_text(f"""<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Emulator>
    <ID>{RETROARCH}</ID>
    <Title>Retroarch</Title>
    <ApplicationPath>Emulators\\RetroArch\\retroarch.exe</ApplicationPath>
    <CommandLine>-f</CommandLine>
    <NoQuotes>false</NoQuotes>
    <NoSpace>false</NoSpace>
  </Emulator>
  <EmulatorPlatform>
    <Emulator>{RETROARCH}</Emulator>
    <Platform>Super Nintendo Entertainment System</Platform>
    <CommandLine>-L "cores\\snes9x_libretro.dll" -f</CommandLine>
    <Default>true</Default>
  </EmulatorPlatform>
</LaunchBox>""", encoding="utf-8")

    for platform in ("Super Nintendo Entertainment System", "Nintendo 64"):
        rows = []
        for i in range(games_per_platform):
            fav = "true" if i % favourite_every == 0 else "false"
            rows.append(f"""  <Game>
    <ID>{platform[:3]}-{i:05d}</ID>
    <Title>{platform[:5]} Game {i}</Title>
    <Platform>{platform}</Platform>
    <ApplicationPath>..\\ROMs\\{platform}\\game {i}.zip</ApplicationPath>
    <Emulator>{RETROARCH}</Emulator>
    <Favorite>{fav}</Favorite>
    <Hide>false</Hide>
    <Notes>Some long description text that makes the file realistically large. {"x" * 200}</Notes>
  </Game>""")
        (root / "Data" / "Platforms" / f"{platform}.xml").write_text(
            '<?xml version="1.0" standalone="yes"?>\n<LaunchBox>\n' + "\n".join(rows) + "\n</LaunchBox>", encoding="utf-8")

    (root / "Data" / "Platforms" / "Windows.xml").write_text("""<?xml version="1.0" standalone="yes"?>
<LaunchBox>
  <Game>
    <ID>win-1</ID>
    <Title>Halo: The Master Chief Collection</Title>
    <Platform>Windows</Platform>
    <ApplicationPath>steam://rungameid/976730</ApplicationPath>
    <Favorite>true</Favorite>
  </Game>
  <Game>
    <ID>win-2</ID>
    <Title>Hidden favourite</Title>
    <Platform>Windows</Platform>
    <ApplicationPath>C:\\Games\\x.exe</ApplicationPath>
    <Favorite>true</Favorite>
    <Hide>true</Hide>
  </Game>
</LaunchBox>""", encoding="utf-8")

    art = root / "Images" / "Windows" / "Box - Front" / "North America"
    art.mkdir(parents=True)
    (art / "Halo_ The Master Chief Collection-01.png").write_bytes(b"PNG")


class LaunchBoxTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "LaunchBox"

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_large_library_only_lists_favourites_quickly(self) -> None:
        write_launchbox(self.root, games_per_platform=10_000, favourite_every=500)
        source = agent.LaunchBoxSource({"path": str(self.root)})
        started = time.time()
        entries = source.entries()
        elapsed = time.time() - started
        # 20 favourites per platform x 2 platforms + Halo (hidden one excluded)
        self.assertEqual(len(entries), 41)
        self.assertLess(elapsed, 10, f"parsing 20k games took {elapsed:.1f}s")
        # Second call is served from cache (files unchanged)
        started = time.time()
        source.entries()
        self.assertLess(time.time() - started, 0.05)

    def test_emulator_command_line_uses_platform_args(self) -> None:
        write_launchbox(self.root, games_per_platform=3, favourite_every=1)
        entries = agent.LaunchBoxSource({"path": str(self.root)}).entries()
        snes = entries["lb-Sup-00001"]
        self.assertEqual(snes["platform"], "Super Nintendo Entertainment System")
        self.assertEqual(snes["controller"], "full")
        line = snes["_launch"]["commandLine"]
        self.assertIn('retroarch.exe" -L "cores', line)
        self.assertTrue(line.endswith('game 1.zip"'), line)
        n64 = entries["lb-Nin-00000"]  # no platform-specific args: emulator default
        self.assertIn('retroarch.exe" -f "', n64["_launch"]["commandLine"])

    def test_pc_games_and_art(self) -> None:
        write_launchbox(self.root, games_per_platform=1, favourite_every=1)
        source = agent.LaunchBoxSource({"path": str(self.root)})
        halo = source.entries()["lb-win-1"]
        self.assertEqual(halo["_launch"], {"file": "steam://rungameid/976730", "args": ""})
        self.assertEqual(halo["controller"], "unknown")
        self.assertIsNotNone(source.art("Windows", "Halo: The Master Chief Collection"))
        self.assertNotIn("lb-win-2", source.entries())

    def test_platform_filter_and_all_games(self) -> None:
        write_launchbox(self.root, games_per_platform=10, favourite_every=5)
        only_n64 = agent.LaunchBoxSource({"path": str(self.root), "platforms": ["Nintendo 64"]}).entries()
        self.assertEqual({e["platform"] for e in only_n64.values()}, {"Nintendo 64"})
        everything = agent.LaunchBoxSource({"path": str(self.root), "favoritesOnly": False}).entries()
        self.assertEqual(len(everything), 21)


class PlayniteTests(unittest.TestCase):
    def test_reads_export(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "hearth-favorites.json"
            path.write_text("\ufeff" + json.dumps([
                {"id": "a1", "name": "Fortnite", "source": "Epic", "platforms": ["PC (Windows)"],
                 "features": ["Full Controller Support"], "tags": [], "installDirectory": "C:\\Epic\\Fortnite", "cover": "C:\\c.jpg"},
                {"id": "b2", "name": "Age of Empires IV", "source": "Xbox", "platforms": ["PC (Windows)"],
                 "features": [], "tags": ["Hearth: KBM"], "installDirectory": None, "cover": None},
            ]), encoding="utf-8")
            entries = agent.PlayniteSource({"exportPath": str(path)}).entries()
            fn, aoe = entries["pn-a1"], entries["pn-b2"]
            self.assertEqual(fn["_launch"], {"uri": "playnite://playnite/start/a1"})
            self.assertEqual((fn["controller"], fn["requiresKbm"], fn["store"]), ("full", False, "Epic"))
            self.assertTrue(aoe["requiresKbm"])
            self.assertFalse(aoe["art"])

    def test_missing_export_is_empty_not_fatal(self) -> None:
        self.assertEqual(agent.PlayniteSource({"exportPath": "/nope/x.json"}).entries(), {})


class LibraryTests(unittest.TestCase):
    def test_frontend_entry_replaces_duplicate_steam_entry(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            export = Path(tmp) / "export.json"
            export.write_text(json.dumps([{"id": "p1", "name": "ELDEN RING", "source": "Steam"}]))
            lib = agent.Library({"token": "t", "steam": {"enabled": False}, "playnite": {"enabled": True, "exportPath": str(export)}}, Path(tmp))
            lib._steam = lambda: {"steam-1245620": {"id": "steam-1245620", "title": "Elden Ring", "source": "steam"}}  # type: ignore[method-assign]
            entries = lib.scan()
            self.assertEqual(list(entries), ["pn-p1"])


if __name__ == "__main__":
    unittest.main()
