# Hearth Exporter: writes your Playnite library to a JSON file that the Hearth PC agent reads.
# Favourites appear in the TV's game library; everything else (installed or not) is available
# under Games > Browse. Covers Steam, Epic, GOG, Xbox / Game Pass, EA, Ubisoft, emulated games
# and games added by hand.
#
# Exported automatically when Playnite starts and closes, after a library update and after
# you play something. Use Extensions > Hearth > "Send library to Hearth" after starring games.
#
# Tag a game "Hearth: KBM" to get the "get your keyboard & mouse ready" prompt on the TV,
# or "Hearth: Controller" to suppress it.

function Export-HearthLibrary {
    param($scriptMainMenuItemActionArgs)

    $db = $PlayniteApi.Database
    $list = foreach ($g in ($db.Games | Where-Object { -not $_.Hidden })) {
        $cover = $null; $background = $null
        if ($g.CoverImage) { $cover = $db.GetFullFilePath($g.CoverImage) }
        if ($g.BackgroundImage -and -not $g.BackgroundImage.StartsWith('http')) { $background = $db.GetFullFilePath($g.BackgroundImage) }
        $description = $g.Description
        if ($description -and $description.Length -gt 1500) { $description = $description.Substring(0, 1500) }
        [ordered]@{
            id               = $g.Id.ToString()
            name             = $g.Name
            favorite         = $g.Favorite
            installed        = $g.IsInstalled
            source           = if ($g.Source) { $g.Source.Name } else { '' }
            platforms        = @($g.Platforms | ForEach-Object { $_.Name })
            features         = @($g.Features | ForEach-Object { $_.Name })
            tags             = @($g.Tags | ForEach-Object { $_.Name })
            genres           = @($g.Genres | ForEach-Object { $_.Name })
            ageRatings       = @($g.AgeRatings | ForEach-Object { $_.Name })
            releaseYear      = if ($g.ReleaseDate) { $g.ReleaseDate.Year } else { $null }
            playtime         = $g.Playtime
            description      = $description
            installDirectory = $g.InstallDirectory
            cover            = $cover
            background       = $background
        }
    }

    $path = Join-Path $PlayniteApi.Paths.ExtensionsDataPath 'hearth-library.json'
    ConvertTo-Json -InputObject @($list) -Depth 4 -Compress | Out-File -FilePath $path -Encoding utf8
    $favs = @($list | Where-Object { $_.favorite }).Count
    $__logger.Info("Hearth: exported $(@($list).Count) games ($favs favourites) to $path")
    if ($scriptMainMenuItemActionArgs) {
        $PlayniteApi.Dialogs.ShowMessage("Sent $(@($list).Count) games ($favs favourites) to Hearth.", 'Hearth')
    }
}

function OnApplicationStarted { Export-HearthLibrary }
function OnApplicationStopped { Export-HearthLibrary }
function OnLibraryUpdated { Export-HearthLibrary }
function OnGameStopped { param($evnArgs) Export-HearthLibrary }

function GetMainMenuItems {
    param($getMainMenuItemsArgs)
    $item = New-Object Playnite.SDK.Plugins.ScriptMainMenuItem
    $item.Description = 'Send library to Hearth'
    $item.FunctionName = 'Export-HearthLibrary'
    $item.MenuSection = '@Hearth'
    return $item
}
