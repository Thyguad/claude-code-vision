using System.Threading;

namespace ClaudeCodeVision.Windows;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        using var singleInstance = new Mutex(true, "Local\\ClaudeCodeVision.Windows", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show("ClaudeCode-Vision 已在运行。", "ClaudeCode-Vision", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApplicationContext());
    }
}
