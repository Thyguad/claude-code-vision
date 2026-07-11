#ifndef AppVersion
  #define AppVersion "0.1.2"
#endif

[Setup]
AppId={{D42AE3B1-3631-4AB4-A6F1-71F0BDB9469B}
AppName=ClaudeCode-Vision
AppVersion={#AppVersion}
AppPublisher=ClaudeCode-Vision contributors
DefaultDirName={localappdata}\Programs\ClaudeCode-Vision
DefaultGroupName=ClaudeCode-Vision
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\..\dist\installer
OutputBaseFilename=ClaudeCode-Vision-{#AppVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=yes
RestartApplications=no
UninstallDisplayIcon={app}\ClaudeCode-Vision.exe
VersionInfoVersion={#AppVersion}

[Files]
Source: "..\..\dist\ClaudeCode-Vision-windows-x64\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\ClaudeCode-Vision"; Filename: "{app}\ClaudeCode-Vision.exe"
Name: "{userdesktop}\ClaudeCode-Vision"; Filename: "{app}\ClaudeCode-Vision.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "附加快捷方式："; Flags: unchecked

[Run]
Filename: "{app}\ClaudeCode-Vision.exe"; Description: "启动 ClaudeCode-Vision"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\runtime\service\cli.mjs"" stop --json"; Flags: runhidden waituntilterminated skipifdoesntexist
Filename: "{sys}\taskkill.exe"; Parameters: "/IM ClaudeCode-Vision.exe /T /F"; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ResultCode: Integer;
  NodePath: String;
  CliPath: String;
begin
  Result := '';
  NodePath := ExpandConstant('{app}\runtime\node\node.exe');
  CliPath := ExpandConstant('{app}\runtime\service\cli.mjs');
  if FileExists(NodePath) and FileExists(CliPath) then
    Exec(NodePath, '"' + CliPath + '" stop --json', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/IM ClaudeCode-Vision.exe /T /F', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;
