# Hearth Exporter: writes your Playnite favourites to a JSON file that the Hearth PC agent
# reads, so the TV shows exactly the games you've starred in Playnite (Steam, Epic, GOG,
# Xbox / Game Pass, EA, Ubisoft, emulated games, manually added ones...).
#
# Exported automatically when Playnite starts and closes, after a library update and after
# you play something. Use Extensions > Hearth > "Export favourites now" after starring games.
#
# Tag a game "Hearth: KBM" to get the "get your keyboard & mouse ready" prompt on the TV,
# or "Hearth: Controller" to suppress it.

$ExportAll = $false   # set to $true to send every game instead of only favourites (not recommended for huge libraries)

function Export-HearthFavorites {
    param($scriptMainMenuItemActionArgs)

    $games = $PlayniteApi.Database.Games | Where-Object { ($ExportAll -or $_.Favorite) -and -not $_.Hidden }
    $list = foreach ($g in $games) {
        $cover = $null
        if ($g.CoverImage) { $cover = $PlayniteApi.Database.GetFullFilePath($g.CoverImage) }
        [ordered]@{
            id               = $g.Id.ToString()
            name             = $g.Name
            source           = if ($g.Source) { $g.Source.Name } else { '' }
            platforms        = @($g.Platforms | ForEach-Object { $_.Name })
            features         = @($g.Features | ForEach-Object { $_.Name })
            tags             = @($g.Tags | ForEach-Object { $_.Name })
            installed        = $g.IsInstalled
            installDirectory = $g.InstallDirectory
            cover            = $cover
        }
    }

    $path = Join-Path $PlayniteApi.Paths.ExtensionsDataPath 'hearth-favorites.json'
    ConvertTo-Json -InputObject @($list) -Depth 4 | Out-File -FilePath $path -Encoding utf8
    $__logger.Info("Hearth: exported $(@($list).Count) games to $path")
    if ($scriptMainMenuItemActionArgs) {
        $PlayniteApi.Dialogs.ShowMessage("Sent $(@($list).Count) games to Hearth.", 'Hearth')
    }
}

function OnApplicationStarted { Export-HearthFavorites }
function OnApplicationStopped { Export-HearthFavorites }
function OnLibraryUpdated { Export-HearthFavorites }
function OnGameStopped { param($evnArgs) Export-HearthFavorites }

function GetMainMenuItems {
    param($getMainMenuItemsArgs)
    $item = New-Object Playnite.SDK.Plugins.ScriptMainMenuItem
    $item.Description = 'Export favourites now'
    $item.FunctionName = 'Export-HearthFavorites'
    $item.MenuSection = '@Hearth'
    return $item
}
