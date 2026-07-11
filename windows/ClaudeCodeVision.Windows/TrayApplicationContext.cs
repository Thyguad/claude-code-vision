using System.Diagnostics;

namespace ClaudeCodeVision.Windows;

internal sealed class TrayApplicationContext : ApplicationContext
{
    private readonly ServiceClient service = new();
    private readonly NotifyIcon tray;
    private readonly ToolStripMenuItem statusItem = new("状态：检查中") { Enabled = false };
    private readonly System.Windows.Forms.Timer timer = new() { Interval = 5000 };
    private readonly SemaphoreSlim operationGate = new(1, 1);
    private bool exiting;

    public TrayApplicationContext()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("启动识图服务", null, async (_, _) => await RunCommandAsync("start"));
        menu.Items.Add("停止识图服务", null, async (_, _) => await RunCommandAsync("stop"));
        menu.Items.Add("重启识图服务", null, async (_, _) => await RunCommandAsync("restart"));
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("识图模型设置...", null, async (_, _) => await OpenSettingsAsync());
        menu.Items.Add("打开日志", null, (_, _) => OpenLog());
        menu.Items.Add("复制诊断信息", null, async (_, _) => await CopyDiagnosticsAsync());
        menu.Items.Add("刷新状态", null, async (_, _) => await RefreshStatusAsync());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出", null, async (_, _) => await ExitAsync());

        tray = new NotifyIcon { Icon = SystemIcons.Application, Text = "Claude Code 识图服务", ContextMenuStrip = menu, Visible = true };
        timer.Tick += async (_, _) => await RefreshStatusAsync();
        timer.Start();
        _ = RunCommandAsync("start");
    }

    private async Task RunCommandAsync(string command)
    {
        await operationGate.WaitAsync();
        ServiceResult result;
        try { result = await service.RunAsync(command); }
        finally { operationGate.Release(); }
        if (!result.Success)
            MessageBox.Show(string.IsNullOrWhiteSpace(result.Error) ? result.Output : result.Error, "ClaudeCode-Vision", MessageBoxButtons.OK, MessageBoxIcon.Error);
        await RefreshStatusAsync();
    }

    private async Task RefreshStatusAsync()
    {
        if (!await operationGate.WaitAsync(0)) return;
        try
        {
            var running = await service.IsRunningAsync();
            statusItem.Text = !service.IsInstalled ? "状态：运行时不完整" : running ? "状态：识图服务已开启" : "状态：识图服务已停止";
            tray.Text = running ? "Claude Code 识图服务：已开启" : "Claude Code 识图服务：已停止";
        }
        finally { operationGate.Release(); }
    }

    private async Task OpenSettingsAsync()
    {
        using var form = new SettingsForm(service.VisionConfigPath);
        if (form.ShowDialog() == DialogResult.OK) await RunCommandAsync("restart");
    }

    private void OpenLog()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(service.LogPath)!);
        if (!File.Exists(service.LogPath)) File.WriteAllText(service.LogPath, "");
        Process.Start(new ProcessStartInfo(service.LogPath) { UseShellExecute = true });
    }

    private async Task CopyDiagnosticsAsync()
    {
        var result = await service.RunAsync("doctor");
        if (!string.IsNullOrWhiteSpace(result.Output)) Clipboard.SetText(result.Output);
        else MessageBox.Show(result.Error, "诊断失败", MessageBoxButtons.OK, MessageBoxIcon.Error);
    }

    private async Task ExitAsync()
    {
        if (exiting) return;
        exiting = true;
        timer.Stop();
        await operationGate.WaitAsync();
        try { await service.RunAsync("stop"); }
        finally { operationGate.Release(); }
        tray.Visible = false;
        tray.Dispose();
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) { timer.Dispose(); tray.Dispose(); operationGate.Dispose(); }
        base.Dispose(disposing);
    }
}
