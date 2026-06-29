using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace AmaduseImagebot
{
    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            string root = ResolveProjectRoot();
            try
            {

                if (args.Length > 0 && args[0].Equals("--self-test", StringComparison.OrdinalIgnoreCase))
                {
                    StatusSnapshot snapshot = GatewayController.GetStatus(root);
                    Console.WriteLine("state=" + snapshot.State);
                    Console.WriteLine("ready=" + snapshot.Ready);
                    Console.WriteLine("port=" + snapshot.Port);
                    Console.WriteLine("pid=" + snapshot.Pid);
                    Console.WriteLine("log=" + snapshot.LogPath);
                    Console.WriteLine("watchdog=" + snapshot.WatchdogState);
                    return;
                }

                if (args.Length > 0 && args[0].Equals("--dump-layout", StringComparison.OrdinalIgnoreCase))
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    MainForm form = new MainForm(root, false);
                    form.CreateControl();
                    form.PerformLayout();
                    DumpControl(form, 0);
                    return;
                }

                if (args.Length > 0 && args[0].Equals("--render-preview", StringComparison.OrdinalIgnoreCase))
                {
                    Application.EnableVisualStyles();
                    Application.SetCompatibleTextRenderingDefault(false);
                    string outputPath = args.Length > 1 ? args[1] : Path.Combine(root, "native-preview.png");
                    using (MainForm form = new MainForm(root, false))
                    using (Bitmap bitmap = new Bitmap(form.Width, form.Height))
                    {
                        form.CreateControl();
                        form.PerformLayout();
                        form.Show();
                        Application.DoEvents();
                        form.Refresh();
                        Application.DoEvents();
                        form.DrawToBitmap(bitmap, new Rectangle(0, 0, form.Width, form.Height));
                        bitmap.Save(outputPath);
                    }
                    Console.WriteLine(outputPath);
                    return;
                }

                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm(root, true));
            }
            catch (Exception ex)
            {
                WriteCrashLog(root, ex);
                MessageBox.Show("Amaduse Imagebot failed to start. See logs\\native-crash.log.", "Amaduse Imagebot", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private static string ResolveProjectRoot()
        {
            List<string> starts = new List<string>();
            AddRootCandidate(starts, Environment.CurrentDirectory);
            AddRootCandidate(starts, AppDomain.CurrentDomain.BaseDirectory);

            foreach (string start in starts)
            {
                DirectoryInfo current = new DirectoryInfo(start);
                while (current != null)
                {
                    if (IsProjectRoot(current.FullName))
                    {
                        return TrimRoot(current.FullName);
                    }
                    current = current.Parent;
                }
            }

            return TrimRoot(AppDomain.CurrentDomain.BaseDirectory);
        }

        private static void AddRootCandidate(List<string> candidates, string path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            try
            {
                string fullPath = Path.GetFullPath(path);
                if (!candidates.Any(delegate(string item) { return string.Equals(item, fullPath, StringComparison.OrdinalIgnoreCase); }))
                {
                    candidates.Add(fullPath);
                }
            }
            catch
            {
            }
        }

        private static bool IsProjectRoot(string path)
        {
            return File.Exists(Path.Combine(path, "START_IMAGEBOT_GATEWAY.ps1"))
                && File.Exists(Path.Combine(path, "imagebot-control-server.js"))
                && Directory.Exists(Path.Combine(path, "scripts"));
        }

        private static string TrimRoot(string path)
        {
            return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static void WriteCrashLog(string root, Exception ex)
        {
            try
            {
                string logDir = Path.Combine(root, "logs");
                Directory.CreateDirectory(logDir);
                StringBuilder sb = new StringBuilder();
                sb.AppendLine(DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
                int depth = 0;
                Exception current = ex;
                while (current != null)
                {
                    sb.AppendLine("Exception depth " + depth);
                    sb.AppendLine("Type: " + current.GetType().FullName);
                    sb.AppendLine("Message: " + current.Message);
                    sb.AppendLine("Stack: " + current.StackTrace);
                    current = current.InnerException;
                    depth++;
                }
                sb.AppendLine();
                File.AppendAllText(Path.Combine(logDir, "native-crash.log"), sb.ToString(), Encoding.UTF8);
            }
            catch
            {
            }
        }

        private static void DumpControl(Control control, int depth)
        {
            string indent = new string(' ', depth * 2);
            Console.WriteLine(indent + control.GetType().Name + " text=\"" + control.Text + "\" bounds=" + control.Bounds);
            foreach (Control child in control.Controls)
            {
                DumpControl(child, depth + 1);
            }
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly string root;
        private readonly bool manageGatewayLifetime;
        private readonly Label statusLabel;
        private readonly Label subStatusLabel;
        private readonly Label portValue;
        private readonly Label pidValue;
        private readonly Label providerValue;
        private readonly Label updatedValue;
        private readonly Label logPathLabel;
        private readonly RichTextBox logBox;
        private readonly Label safetyLabel;
        private readonly Label startButton;
        private readonly Label stopButton;
        private readonly Label restartButton;
        private readonly Label refreshButton;
        private readonly Button openDashboardButton;
        private readonly Button openConfigButton;
        private readonly Button openWorkspaceButton;
        private readonly Button openLogsButton;
        private readonly Button fastModeButton;
        private readonly Button balancedModeButton;
        private readonly Button deepModeButton;
        private readonly Button exitButton;
        private readonly SignalView signalView;
        private readonly Timer refreshTimer;
        private bool busy;
        private bool refreshing;
        private bool shutdownRequested;
        private bool closeAfterManagedStop;

        public MainForm(string root) : this(root, true)
        {
        }

        public MainForm(string root, bool manageGatewayLifetime)
        {
            this.root = root;
            this.manageGatewayLifetime = manageGatewayLifetime;
            Text = "Amaduse Imagebot";
            StartPosition = FormStartPosition.CenterScreen;
            MinimumSize = new Size(920, 640);
            Size = new Size(1060, 720);
            AutoScaleMode = AutoScaleMode.None;
            Font = new Font("Segoe UI", 10f, FontStyle.Regular);
            BackColor = Theme.Background;
            ForeColor = Theme.Text;
            DoubleBuffered = true;

            HeaderPanel header = new HeaderPanel();
            header.Dock = DockStyle.Top;
            header.Height = 94;
            header.Padding = new Padding(20, 16, 20, 12);
            Controls.Add(header);

            BrandMark mark = new BrandMark();
            mark.Location = new Point(22, 18);
            mark.Size = new Size(58, 58);
            header.Controls.Add(mark);

            Label title = new Label();
            title.AutoSize = true;
            title.BackColor = Color.Transparent;
            title.Font = new Font("Segoe UI", 17f, FontStyle.Bold);
            title.Text = "Amaduse Imagebot";
            title.Location = new Point(96, 18);
            header.Controls.Add(title);

            subStatusLabel = new Label();
            subStatusLabel.AutoSize = true;
            subStatusLabel.BackColor = Color.Transparent;
            subStatusLabel.ForeColor = Theme.Muted;
            subStatusLabel.Text = "Checking gateway state";
            subStatusLabel.Location = new Point(100, 54);
            header.Controls.Add(subStatusLabel);

            statusLabel = new Label();
            statusLabel.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            statusLabel.TextAlign = ContentAlignment.MiddleCenter;
            statusLabel.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            statusLabel.Size = new Size(142, 38);
            statusLabel.Location = new Point(Width - 188, 28);
            statusLabel.BackColor = Theme.AmberDim;
            statusLabel.ForeColor = Theme.Text;
            statusLabel.Text = "CHECKING";
            header.Controls.Add(statusLabel);
            Resize += delegate { statusLabel.Location = new Point(ClientSize.Width - 188, 28); };

            TableLayoutPanel mainGrid = new TableLayoutPanel();
            mainGrid.Dock = DockStyle.None;
            mainGrid.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            mainGrid.Location = new Point(0, header.Height);
            mainGrid.Size = new Size(ClientSize.Width, Math.Max(100, ClientSize.Height - header.Height));
            mainGrid.Padding = new Padding(18);
            mainGrid.BackColor = Theme.Background;
            mainGrid.RowCount = 2;
            mainGrid.ColumnCount = 2;
            mainGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 62f));
            mainGrid.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 38f));
            mainGrid.RowStyles.Add(new RowStyle(SizeType.Absolute, 304f));
            mainGrid.RowStyles.Add(new RowStyle(SizeType.Percent, 100f));
            Controls.Add(mainGrid);
            Resize += delegate
            {
                mainGrid.Location = new Point(0, header.Height);
                mainGrid.Size = new Size(ClientSize.Width, Math.Max(100, ClientSize.Height - header.Height));
            };

            Panel commandPanel = new CommandDeckPanel();
            commandPanel.Dock = DockStyle.Fill;
            commandPanel.Margin = new Padding(0, 0, 14, 14);
            commandPanel.BackColor = Theme.Panel;
            commandPanel.Padding = new Padding(18);
            mainGrid.Controls.Add(commandPanel, 0, 0);

            Label deckKicker = MakeDeckLabel("PRIVATE IMAGEBOT TERMINAL", 9f, FontStyle.Bold, Theme.Cyan);
            deckKicker.Location = new Point(22, 18);
            deckKicker.Size = new Size(260, 18);
            commandPanel.Controls.Add(deckKicker);

            Label deckTitle = MakeDeckLabel("AMADEUS CONTROL", 22f, FontStyle.Bold, Theme.Text);
            deckTitle.Location = new Point(22, 38);
            deckTitle.Size = new Size(420, 38);
            commandPanel.Controls.Add(deckTitle);

            Label deckSub = MakeDeckLabel("local gateway / telegram bridge / image tools", 9.5f, FontStyle.Regular, Theme.Muted);
            deckSub.Location = new Point(24, 76);
            deckSub.Size = new Size(430, 22);
            commandPanel.Controls.Add(deckSub);

            startButton = MakeActionButton("START", Theme.Green);
            stopButton = MakeActionButton("STOP", Theme.Red);
            restartButton = MakeActionButton("RESTART", Theme.Amber);
            refreshButton = MakeActionButton("STATUS", Theme.Cyan);
            commandPanel.Controls.Add(startButton);
            commandPanel.Controls.Add(stopButton);
            commandPanel.Controls.Add(restartButton);
            commandPanel.Controls.Add(refreshButton);

            TableLayoutPanel metrics = new TableLayoutPanel();
            metrics.Dock = DockStyle.None;
            metrics.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            metrics.Location = new Point(18, 194);
            metrics.Size = new Size(572, 104);
            metrics.Padding = new Padding(0);
            metrics.ColumnCount = 4;
            metrics.RowCount = 1;
            metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
            metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
            metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
            metrics.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25f));
            commandPanel.Controls.Add(metrics);

            portValue = AddMetric(metrics, 0, "Port", "127.0.0.1:18789");
            pidValue = AddMetric(metrics, 1, "PID", "none");
            providerValue = AddMetric(metrics, 2, "Provider", "unknown");
            updatedValue = AddMetric(metrics, 3, "Updated", "--:--:--");
            commandPanel.Resize += delegate
            {
                int width = Math.Max(260, commandPanel.ClientSize.Width - 36);
                int gap = 12;
                int buttonWidth = Math.Max(118, (width - gap * 3) / 4);
                int buttonY = 108;
                startButton.SetBounds(18, buttonY, buttonWidth, 70);
                stopButton.SetBounds(18 + buttonWidth + gap, buttonY, buttonWidth, 70);
                restartButton.SetBounds(18 + (buttonWidth + gap) * 2, buttonY, buttonWidth, 70);
                refreshButton.SetBounds(18 + (buttonWidth + gap) * 3, buttonY, buttonWidth, 70);
                metrics.Location = new Point(18, 194);
                metrics.Size = new Size(width, Math.Max(76, commandPanel.ClientSize.Height - 214));
            };
            startButton.SetBounds(18, 108, 132, 70);
            stopButton.SetBounds(162, 108, 132, 70);
            restartButton.SetBounds(306, 108, 132, 70);
            refreshButton.SetBounds(450, 108, 132, 70);

            Panel sidePanel = MakePanel();
            sidePanel.Padding = new Padding(16);
            mainGrid.Controls.Add(sidePanel, 1, 0);

            MascotView mascot = new MascotView();
            mascot.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            mascot.Location = new Point(16, 14);
            mascot.Size = new Size(sidePanel.Width - 32, 170);
            sidePanel.Controls.Add(mascot);

            Label signalTitle = new Label();
            signalTitle.AutoSize = true;
            signalTitle.BackColor = Color.Transparent;
            signalTitle.ForeColor = Theme.Muted;
            signalTitle.Text = "Signal Trace";
            signalTitle.Location = new Point(16, 196);
            sidePanel.Controls.Add(signalTitle);

            signalView = new SignalView();
            signalView.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            signalView.Location = new Point(16, 218);
            signalView.Size = new Size(sidePanel.Width - 32, 48);
            sidePanel.Controls.Add(signalView);

            safetyLabel = new Label();
            safetyLabel.Anchor = AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom;
            safetyLabel.BackColor = Color.Transparent;
            safetyLabel.ForeColor = Theme.Muted;
            safetyLabel.AutoEllipsis = true;
            safetyLabel.Text = "Loopback   |   Group locked   |   Image tools";
            safetyLabel.TextAlign = ContentAlignment.MiddleCenter;
            safetyLabel.Location = new Point(16, 274);
            safetyLabel.Size = new Size(sidePanel.Width - 32, 20);
            sidePanel.Controls.Add(safetyLabel);
            sidePanel.Resize += delegate
            {
                mascot.Width = sidePanel.ClientSize.Width - 32;
                signalView.Width = sidePanel.ClientSize.Width - 32;
                mascot.Height = Math.Max(160, sidePanel.ClientSize.Height - 118);
                signalTitle.Location = new Point(16, mascot.Bottom + 10);
                signalView.Location = new Point(16, signalTitle.Bottom + 6);
                safetyLabel.Location = new Point(16, Math.Max(signalView.Bottom + 8, sidePanel.ClientSize.Height - 24));
                safetyLabel.Width = sidePanel.ClientSize.Width - 32;
            };

            Panel logPanel = MakePanel();
            logPanel.Padding = new Padding(16);
            mainGrid.SetColumnSpan(logPanel, 2);
            mainGrid.Controls.Add(logPanel, 0, 1);

            Label logTitle = new Label();
            logTitle.AutoSize = true;
            logTitle.BackColor = Color.Transparent;
            logTitle.Font = new Font("Segoe UI", 13f, FontStyle.Bold);
            logTitle.Text = "Gateway Log";
            logTitle.Location = new Point(16, 14);
            logPanel.Controls.Add(logTitle);

            logPathLabel = new Label();
            logPathLabel.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            logPathLabel.BackColor = Color.Transparent;
            logPathLabel.ForeColor = Theme.Muted;
            logPathLabel.Location = new Point(16, 44);
            logPathLabel.Size = new Size(logPanel.Width - 300, 42);
            logPathLabel.Text = "No log yet";
            logPanel.Controls.Add(logPathLabel);
            logPanel.Resize += delegate { logPathLabel.Width = Math.Max(260, logPanel.ClientSize.Width - 330); };

            openDashboardButton = MakeSmallButton("Dashboard");
            openDashboardButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(openDashboardButton);

            openConfigButton = MakeSmallButton("Config");
            openConfigButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(openConfigButton);

            openWorkspaceButton = MakeSmallButton("Workspace");
            openWorkspaceButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(openWorkspaceButton);

            openLogsButton = MakeSmallButton("Logs");
            openLogsButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(openLogsButton);

            fastModeButton = MakeSmallButton("Fast");
            fastModeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(fastModeButton);

            balancedModeButton = MakeSmallButton("Balanced");
            balancedModeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(balancedModeButton);

            deepModeButton = MakeSmallButton("Deep");
            deepModeButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(deepModeButton);

            exitButton = MakeSmallButton("Exit");
            exitButton.Anchor = AnchorStyles.Top | AnchorStyles.Right;
            logPanel.Controls.Add(exitButton);

            Action layoutLogButtons = delegate
            {
                Button[] buttons = new Button[] { openDashboardButton, openConfigButton, openWorkspaceButton, openLogsButton, fastModeButton, balancedModeButton, deepModeButton, exitButton };
                int gap = 8;
                int width = Math.Max(78, Math.Min(104, (logPanel.ClientSize.Width - 32 - gap * (buttons.Length - 1)) / buttons.Length));
                int total = buttons.Length * width + (buttons.Length - 1) * gap;
                int x = Math.Max(16, logPanel.ClientSize.Width - total - 16);
                for (int i = 0; i < buttons.Length; i++)
                {
                    buttons[i].SetBounds(x + i * (width + gap), 24, width, 34);
                }
                logPathLabel.Width = Math.Max(220, x - 32);
            };
            layoutLogButtons();
            logPanel.Resize += delegate { layoutLogButtons(); };

            logBox = new RichTextBox();
            logBox.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
            logBox.Location = new Point(16, 92);
            logBox.Size = new Size(logPanel.Width - 32, logPanel.Height - 108);
            logBox.BackColor = Color.FromArgb(9, 11, 11);
            logBox.ForeColor = Color.FromArgb(216, 230, 222);
            logBox.BorderStyle = BorderStyle.None;
            logBox.Font = new Font("Consolas", 9f);
            logBox.ReadOnly = true;
            logBox.WordWrap = false;
            logBox.Text = "Waiting for status...";
            logPanel.Controls.Add(logBox);
            logPanel.Resize += delegate
            {
                logBox.Size = new Size(logPanel.ClientSize.Width - 32, logPanel.ClientSize.Height - 108);
            };

            startButton.Click += delegate { RunActionAsync("start"); };
            stopButton.Click += delegate { RunActionAsync("stop"); };
            restartButton.Click += delegate { RunActionAsync("restart"); };
            refreshButton.Click += delegate { RunActionAsync("status"); };
            openDashboardButton.Click += delegate { GatewayController.OpenDashboard(); };
            openConfigButton.Click += delegate { GatewayController.OpenConfigFolder(); };
            openWorkspaceButton.Click += delegate { GatewayController.OpenWorkspace(root); };
            openLogsButton.Click += delegate { GatewayController.OpenLogFolder(root); };
            fastModeButton.Click += delegate { RunActionAsync("mode-fast"); };
            balancedModeButton.Click += delegate { RunActionAsync("mode-balanced"); };
            deepModeButton.Click += delegate { RunActionAsync("mode-deep"); };
            exitButton.Click += delegate { Close(); };
            FormClosing += HandleFormClosing;

            refreshTimer = new Timer();
            refreshTimer.Interval = 3000;
            refreshTimer.Tick += delegate
            {
                if (!busy)
                {
                    RefreshStatusAsync();
                }
                signalView.Invalidate();
            };
            refreshTimer.Start();

            Shown += delegate
            {
                if (this.manageGatewayLifetime)
                {
                    RunActionAsync("start");
                }
                else
                {
                    RefreshStatusAsync();
                }
            };
        }

        private static Panel MakePanel()
        {
            DecoratedPanel panel = new DecoratedPanel();
            panel.Dock = DockStyle.Fill;
            panel.Margin = new Padding(0, 0, 14, 14);
            return panel;
        }

        private static Label MakeDeckLabel(string text, float size, FontStyle style, Color color)
        {
            Label label = new Label();
            label.AutoSize = false;
            label.BackColor = Color.Transparent;
            label.ForeColor = color;
            label.Font = new Font("Segoe UI", size, style);
            label.Text = text;
            label.AutoEllipsis = true;
            return label;
        }

        private static Label MakeActionButton(string text, Color backColor)
        {
            LauncherActionLabel button = new LauncherActionLabel();
            button.AccentColor = backColor;
            button.AutoSize = false;
            button.Dock = DockStyle.None;
            button.Margin = new Padding(0, 0, 10, 0);
            button.BackColor = Color.Transparent;
            button.ForeColor = Theme.Text;
            button.Text = text;
            button.TextAlign = ContentAlignment.MiddleCenter;
            button.Font = new Font("Segoe UI", 11f, FontStyle.Bold);
            button.Cursor = Cursors.Hand;
            return button;
        }

        private static Button MakeSmallButton(string text)
        {
            MiniButton button = new MiniButton();
            button.Size = new Size(104, 34);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderColor = Theme.Line;
            button.BackColor = Theme.PanelStrong;
            button.ForeColor = Theme.Text;
            button.Text = text;
            button.Cursor = Cursors.Hand;
            return button;
        }

        private static Label AddMetric(TableLayoutPanel parent, int column, string caption, string value)
        {
            MetricPanel panel = new MetricPanel();
            panel.Dock = DockStyle.Fill;
            panel.Margin = new Padding(0, 0, 10, 0);
            panel.Padding = new Padding(12);
            parent.Controls.Add(panel, column, 0);

            Label cap = new Label();
            cap.AutoSize = true;
            cap.BackColor = Color.Transparent;
            cap.ForeColor = Theme.Muted;
            cap.Text = caption;
            cap.Location = new Point(12, 10);
            panel.Controls.Add(cap);

            Label val = new Label();
            val.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
            val.BackColor = Color.Transparent;
            val.Font = new Font("Segoe UI", 10.5f, FontStyle.Bold);
            val.Text = value;
            val.AutoEllipsis = true;
            val.Location = new Point(12, 38);
            val.Size = new Size(panel.Width - 24, 24);
            panel.Controls.Add(val);
            panel.Resize += delegate { val.Width = panel.ClientSize.Width - 24; };
            return val;
        }

        private async void RefreshStatusAsync()
        {
            if (refreshing)
            {
                return;
            }

            refreshing = true;
            try
            {
                StatusSnapshot snapshot = await Task.Run(delegate { return GatewayController.GetStatus(root); });
                RenderStatus(snapshot);
            }
            catch (Exception ex)
            {
                subStatusLabel.Text = "Status check failed";
                logBox.Text = ex.Message;
            }
            finally
            {
                refreshing = false;
                UseWaitCursor = false;
                Cursor = Cursors.Default;
            }
        }

        private async void RunActionAsync(string action)
        {
            if (busy || shutdownRequested)
            {
                return;
            }

            try
            {
                SetBusy(true);
                subStatusLabel.Text = char.ToUpper(action[0]) + action.Substring(1) + " requested";
                logBox.Text = "Running " + action + "...";

                ActionResult result = await Task.Run(delegate { return GatewayController.RunAction(root, action); });
                if (!string.IsNullOrWhiteSpace(result.Output))
                {
                    logBox.Text = result.Output.Trim();
                }
                subStatusLabel.Text = result.Success ? action + " finished" : action + " failed";

                StatusSnapshot snapshot = await Task.Run(delegate { return GatewayController.GetStatus(root); });
                RenderStatus(snapshot);
            }
            catch (Exception ex)
            {
                subStatusLabel.Text = action + " failed";
                logBox.Text = ex.Message;
            }
            finally
            {
                SetBusy(false);
            }
        }

        private async void HandleFormClosing(object sender, FormClosingEventArgs e)
        {
            if (!manageGatewayLifetime || closeAfterManagedStop)
            {
                return;
            }

            e.Cancel = true;
            if (shutdownRequested)
            {
                return;
            }

            shutdownRequested = true;
            refreshTimer.Stop();

            try
            {
                while (busy)
                {
                    subStatusLabel.Text = "Waiting for current gateway action before exit";
                    await Task.Delay(250);
                }

                SetBusy(true);
                subStatusLabel.Text = "Stopping gateway before launcher exit";
                logBox.Text = "Stopping gateway before launcher exit...";

                ActionResult result = await Task.Run(delegate { return GatewayController.RunAction(root, "stop"); });
                if (!string.IsNullOrWhiteSpace(result.Output))
                {
                    logBox.Text = result.Output.Trim();
                }

                StatusSnapshot snapshot = await Task.Run(delegate { return GatewayController.GetStatus(root); });
                RenderStatus(snapshot);

                if (!result.Success)
                {
                    shutdownRequested = false;
                    refreshTimer.Start();
                    SetBusy(false);
                    MessageBox.Show("Gateway stop failed. The launcher will stay open so you can inspect the log.", "Amaduse Imagebot", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                closeAfterManagedStop = true;
                Close();
            }
            catch (Exception ex)
            {
                shutdownRequested = false;
                refreshTimer.Start();
                SetBusy(false);
                logBox.Text = ex.Message;
                MessageBox.Show("Gateway stop failed. The launcher will stay open so you can inspect the log.", "Amaduse Imagebot", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        private void SetBusy(bool value)
        {
            busy = value;
            startButton.Enabled = !value;
            stopButton.Enabled = !value;
            restartButton.Enabled = !value;
            refreshButton.Enabled = !value;
            fastModeButton.Enabled = !value;
            balancedModeButton.Enabled = !value;
            deepModeButton.Enabled = !value;
            UseWaitCursor = false;
            Application.UseWaitCursor = false;
            Cursor = Cursors.Default;
        }

        private void RenderStatus(StatusSnapshot snapshot)
        {
            if (snapshot.Ready || snapshot.WatchdogState == "running")
            {
                statusLabel.Text = snapshot.Ready ? "ONLINE" : "BUSY";
                statusLabel.BackColor = snapshot.Ready ? Theme.GreenDim : Theme.AmberDim;
                subStatusLabel.Text = snapshot.Ready ? "Gateway online" : "Gateway running; health check is slow";
                signalView.Running = true;
            }
            else if (snapshot.WatchdogState == "restarting")
            {
                statusLabel.Text = "RESTARTING";
                statusLabel.BackColor = Theme.AmberDim;
                subStatusLabel.Text = string.IsNullOrWhiteSpace(snapshot.WatchdogMessage) ? "Gateway crashed; watchdog is restarting" : snapshot.WatchdogMessage;
                signalView.Running = false;
            }
            else if (snapshot.WatchdogState == "starting")
            {
                statusLabel.Text = "STARTING";
                statusLabel.BackColor = Theme.AmberDim;
                subStatusLabel.Text = "Gateway is starting";
                signalView.Running = false;
            }
            else if (snapshot.WatchdogState == "crashed")
            {
                statusLabel.Text = "CRASHED";
                statusLabel.BackColor = Theme.RedDim;
                subStatusLabel.Text = string.IsNullOrWhiteSpace(snapshot.WatchdogMessage) ? "Gateway crashed; restart limit reached" : snapshot.WatchdogMessage;
                signalView.Running = false;
            }
            else
            {
                statusLabel.Text = "OFFLINE";
                statusLabel.BackColor = Theme.RedDim;
                subStatusLabel.Text = "Gateway offline";
                signalView.Running = false;
            }

            portValue.Text = snapshot.Port;
            pidValue.Text = string.IsNullOrWhiteSpace(snapshot.Pid) ? "none" : snapshot.Pid;
            providerValue.Text = snapshot.ProviderSeen ? "@YOUR_BOT_USERNAME" : "unknown";
            updatedValue.Text = snapshot.UpdatedAt.ToString("HH:mm:ss");
            string model = string.IsNullOrWhiteSpace(snapshot.Model) ? "model unknown" : Shorten(snapshot.Model, 36);
            string plugins = snapshot.PluginCount > 0 ? snapshot.PluginCount + " plugins" : "plugins unknown";
            string health = snapshot.ErrorCount > 0 ? snapshot.ErrorCount + " err" : (snapshot.WarningCount > 0 ? snapshot.WarningCount + " warn" : "nominal");
            safetyLabel.Text = "Loopback   |   " + model + "   |   " + plugins + "   |   " + health;
            logPathLabel.Text = string.IsNullOrWhiteSpace(snapshot.LogPath) ? "No log yet" : snapshot.LogPath;

            if (snapshot.LogTail.Count > 0)
            {
                logBox.Text = string.Join(Environment.NewLine, snapshot.LogTail.ToArray());
                logBox.SelectionStart = logBox.TextLength;
                logBox.ScrollToCaret();
            }
            else if (!busy)
            {
                logBox.Text = "No gateway log yet.";
            }
        }

        private static string Shorten(string value, int max)
        {
            if (string.IsNullOrWhiteSpace(value) || value.Length <= max)
            {
                return value;
            }
            return value.Substring(0, Math.Max(1, max - 1)) + "...";
        }
    }

    internal static class GatewayController
    {
        public static StatusSnapshot GetStatus(string root)
        {
            bool ready = IsGatewayReady();
            string savedPid = ReadText(Path.Combine(root, ".runtime", "imagebot-gateway.pid")).Trim();
            string watchdogStatePath = Path.Combine(root, ".runtime", "imagebot-gateway.state.json");
            string watchdogJson = ReadText(watchdogStatePath);
            string watchdogState = ReadJsonString(watchdogJson, "state");
            string watchdogMessage = ReadJsonString(watchdogJson, "message");
            string lastExitCode = ReadJsonValue(watchdogJson, "lastExitCode");
            string restartCount = ReadJsonValue(watchdogJson, "restartCount");
            string logPath = GetLogPath(root);
            List<string> tail = ReadTail(logPath, 80);
            bool providerSeen = tail.Any(delegate(string line) { return line.IndexOf("[telegram] [imagebot] starting provider", StringComparison.OrdinalIgnoreCase) >= 0; });
            string modelLine = LatestLine(tail, "[gateway] agent model:");
            string model = Regex.Replace(modelLine, "^.*agent model:\\s*", "", RegexOptions.IgnoreCase).Trim();
            string pluginsLine = LatestLine(tail, "[gateway] http server listening");
            Match pluginMatch = Regex.Match(pluginsLine, "\\((\\d+)\\s+plugins:\\s*([^;)]+)", RegexOptions.IgnoreCase);
            int pluginCount = 0;
            if (pluginMatch.Success)
            {
                int.TryParse(pluginMatch.Groups[1].Value, out pluginCount);
            }
            int sessionStart = tail.FindLastIndex(delegate(string line) { return line.IndexOf("[gateway] loading configuration", StringComparison.OrdinalIgnoreCase) >= 0; });
            List<string> healthTail = sessionStart >= 0 ? tail.Skip(sessionStart).ToList() : tail;
            int warningCount = healthTail.Count(delegate(string line) { return Regex.IsMatch(line, "\\b(warn|warning|degraded|retry|timeout|conflict|blocked)\\b", RegexOptions.IgnoreCase); });
            int errorCount = healthTail.Count(delegate(string line) { return Regex.IsMatch(line, "\\b(error|failed|exception|fatal|conflict|blocked)\\b", RegexOptions.IgnoreCase); });

            StatusSnapshot snapshot = new StatusSnapshot();
            snapshot.Ready = ready;
            snapshot.State = ready ? "running" : (!string.IsNullOrWhiteSpace(watchdogState) ? watchdogState : "stopped");
            snapshot.Port = "127.0.0.1:18789";
            snapshot.Pid = !string.IsNullOrWhiteSpace(savedPid) ? savedPid : (ready ? "listening" : "none");
            snapshot.LogPath = logPath;
            snapshot.LogTail = tail;
            snapshot.ProviderSeen = providerSeen;
            snapshot.UpdatedAt = DateTime.Now;
            snapshot.WatchdogState = watchdogState;
            snapshot.WatchdogMessage = watchdogMessage;
            snapshot.LastExitCode = lastExitCode;
            snapshot.RestartCount = restartCount;
            snapshot.Model = model;
            snapshot.PluginCount = pluginCount;
            snapshot.WarningCount = warningCount;
            snapshot.ErrorCount = errorCount;
            return snapshot;
        }

        public static ActionResult RunAction(string root, string action)
        {
            string script = null;
            if (action == "start") script = "START_IMAGEBOT_GATEWAY.ps1";
            if (action == "stop") script = "STOP_IMAGEBOT_GATEWAY.ps1";
            if (action == "restart") script = "RESTART_IMAGEBOT_GATEWAY.ps1";
            if (action == "status") script = "STATUS_IMAGEBOT_GATEWAY.ps1";
            bool modelModeAction = action.StartsWith("mode-", StringComparison.OrdinalIgnoreCase);
            if (modelModeAction) script = "SET_IMAGEBOT_MODEL_MODE.ps1";
            if (script == null) return new ActionResult(false, "Unknown action: " + action);

            string scriptPath = modelModeAction ? ResolveModelScript(root) : Path.Combine(root, script);
            if (!File.Exists(scriptPath))
            {
                return new ActionResult(false, "Missing script: " + scriptPath);
            }

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            string extraArgs = "";
            if (modelModeAction)
            {
                string mode = action.Substring("mode-".Length).ToLowerInvariant();
                if (mode != "fast" && mode != "balanced" && mode != "deep")
                {
                    return new ActionResult(false, "Unknown model mode: " + mode);
                }
                extraArgs = " -Mode " + mode;
            }
            else if (action != "status")
            {
                extraArgs = " -Fast";
            }
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File \"" + scriptPath + "\"" + extraArgs;
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            try
            {
                using (Process proc = Process.Start(psi))
                {
                    string stdout = proc.StandardOutput.ReadToEnd();
                    string stderr = proc.StandardError.ReadToEnd();
                    bool exited = proc.WaitForExit(90000);
                    if (!exited)
                    {
                        try { proc.Kill(); } catch { }
                        return new ActionResult(false, "Timed out while running " + action + ".");
                    }

                    string output = (stdout + Environment.NewLine + stderr).Trim();
                    return new ActionResult(proc.ExitCode == 0, output);
                }
            }
            catch (Exception ex)
            {
                return new ActionResult(false, ex.Message);
            }
        }

        private static string ResolveModelScript(string root)
        {
            string[] candidates = new string[]
            {
                Path.Combine(root, "scripts", "SET_IMAGEBOT_MODEL_MODE.ps1"),
                Path.Combine(root, "SET_IMAGEBOT_MODEL_MODE.ps1"),
                Path.GetFullPath(Path.Combine(root, "..", "..", "scripts", "SET_IMAGEBOT_MODEL_MODE.ps1"))
            };
            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }
            return candidates[0];
        }

        public static void OpenLogFolder(string root)
        {
            string logDir = Path.Combine(root, "logs");
            Directory.CreateDirectory(logDir);
            Process.Start("explorer.exe", logDir);
        }

        public static void OpenWorkspace(string root)
        {
            Directory.CreateDirectory(root);
            Process.Start("explorer.exe", root);
        }

        public static void OpenConfigFolder()
        {
            string openClawHome = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".openclaw");
            Directory.CreateDirectory(openClawHome);
            Process.Start("explorer.exe", openClawHome);
        }

        public static void OpenDashboard()
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"openclaw dashboard\"";
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            Process.Start(psi);
        }

        private static bool IsGatewayReady()
        {
            try
            {
                using (System.Net.Sockets.TcpClient client = new System.Net.Sockets.TcpClient())
                {
                    IAsyncResult result = client.BeginConnect(IPAddress.Loopback, 18789, null, null);
                    bool connected = result.AsyncWaitHandle.WaitOne(700);
                    if (!connected)
                    {
                        return false;
                    }
                    client.EndConnect(result);
                    return true;
                }
            }
            catch
            {
                return false;
            }
        }

        private static List<string> GetGatewayPids(string root)
        {
            string command = "$owners=@(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); $owners -join ','";
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "powershell.exe";
            psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -Command \"" + command.Replace("\"", "\\\"") + "\"";
            psi.WorkingDirectory = root;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;

            List<string> pids = new List<string>();
            try
            {
                using (Process proc = Process.Start(psi))
                {
                    string output = proc.StandardOutput.ReadToEnd();
                    proc.WaitForExit(5000);
                    foreach (string item in output.Trim().Split(new char[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
                    {
                        pids.Add(item.Trim());
                    }
                }
            }
            catch
            {
            }
            return pids;
        }

        private static string LatestLine(List<string> lines, string needle)
        {
            for (int i = lines.Count - 1; i >= 0; i--)
            {
                if (lines[i].IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    return lines[i];
                }
            }
            return "";
        }

        private static string GetLogPath(string root)
        {
            string runtimePath = Path.Combine(root, ".runtime", "imagebot-gateway.logpath");
            string saved = ReadText(runtimePath).Trim();
            if (!string.IsNullOrWhiteSpace(saved))
            {
                return saved;
            }

            string logDir = Path.Combine(root, "logs");
            if (!Directory.Exists(logDir))
            {
                return "";
            }

            FileInfo latest = new DirectoryInfo(logDir)
                .GetFiles("imagebot-gateway-*.log")
                .OrderByDescending(delegate(FileInfo file) { return file.LastWriteTimeUtc; })
                .FirstOrDefault();
            return latest == null ? "" : latest.FullName;
        }

        private static List<string> ReadTail(string path, int maxLines)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                return new List<string>();
            }

            string content = ReadText(path).Replace("\r\n", "\n");
            if (content.Length == 0)
            {
                return new List<string>();
            }

            string[] lines = content.Split(new char[] { '\n' }, StringSplitOptions.RemoveEmptyEntries);
            return lines.Skip(Math.Max(0, lines.Length - maxLines)).ToList();
        }

        private static string ReadText(string path)
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
            {
                return "";
            }

            byte[] bytes;
            using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
            {
                bytes = new byte[stream.Length];
                int offset = 0;
                while (offset < bytes.Length)
                {
                    int read = stream.Read(bytes, offset, bytes.Length - offset);
                    if (read <= 0)
                    {
                        break;
                    }
                    offset += read;
                }
                if (offset < bytes.Length)
                {
                    Array.Resize(ref bytes, offset);
                }
            }
            if (bytes.Length >= 2 && bytes[0] == 0xff && bytes[1] == 0xfe)
            {
                return Encoding.Unicode.GetString(bytes).TrimStart('\uFEFF');
            }

            int sample = Math.Min(bytes.Length, 4096);
            int nulls = 0;
            for (int i = 0; i < sample; i++)
            {
                if (bytes[i] == 0) nulls++;
            }
            if (sample > 0 && nulls > sample / 12)
            {
                return Encoding.Unicode.GetString(bytes).TrimStart('\uFEFF');
            }

            return Encoding.UTF8.GetString(bytes);
        }

        private static string ReadJsonString(string json, string key)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return "";
            }

            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"(?<value>(?:\\\\.|[^\"])*)\"", RegexOptions.IgnoreCase);
            if (!match.Success)
            {
                return "";
            }

            return Regex.Unescape(match.Groups["value"].Value);
        }

        private static string ReadJsonValue(string json, string key)
        {
            if (string.IsNullOrWhiteSpace(json))
            {
                return "";
            }

            Match match = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*(?<value>null|-?\\d+|true|false)", RegexOptions.IgnoreCase);
            if (!match.Success)
            {
                return "";
            }

            string value = match.Groups["value"].Value;
            return value == "null" ? "" : value;
        }
    }

    internal sealed class StatusSnapshot
    {
        public string State;
        public bool Ready;
        public string Port;
        public string Pid;
        public string LogPath;
        public List<string> LogTail;
        public bool ProviderSeen;
        public DateTime UpdatedAt;
        public string WatchdogState;
        public string WatchdogMessage;
        public string LastExitCode;
        public string RestartCount;
        public string Model;
        public int PluginCount;
        public int WarningCount;
        public int ErrorCount;
    }

    internal sealed class ActionResult
    {
        public readonly bool Success;
        public readonly string Output;

        public ActionResult(bool success, string output)
        {
            Success = success;
            Output = output;
        }
    }

    internal static class Theme
    {
        public static readonly Color Background = Color.FromArgb(12, 16, 21);
        public static readonly Color Panel = Color.FromArgb(18, 23, 29);
        public static readonly Color PanelStrong = Color.FromArgb(26, 33, 40);
        public static readonly Color Line = Color.FromArgb(68, 82, 92);
        public static readonly Color Text = Color.FromArgb(252, 250, 244);
        public static readonly Color Muted = Color.FromArgb(176, 188, 193);
        public static readonly Color Green = Color.FromArgb(71, 218, 150);
        public static readonly Color Cyan = Color.FromArgb(76, 212, 229);
        public static readonly Color Rose = Color.FromArgb(246, 115, 137);
        public static readonly Color Red = Color.FromArgb(255, 105, 111);
        public static readonly Color Amber = Color.FromArgb(242, 190, 83);
        public static readonly Color Blue = Color.FromArgb(112, 170, 246);
        public static readonly Color GreenDim = Color.FromArgb(25, 76, 58);
        public static readonly Color RedDim = Color.FromArgb(88, 38, 48);
        public static readonly Color AmberDim = Color.FromArgb(86, 67, 34);
        public static readonly Color RoseDim = Color.FromArgb(72, 44, 57);
    }

    internal static class DrawingUtil
    {
        public static GraphicsPath RoundedRect(Rectangle rect, int radius)
        {
            int d = radius * 2;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(rect.X, rect.Y, d, d, 180, 90);
            path.AddArc(rect.Right - d, rect.Y, d, d, 270, 90);
            path.AddArc(rect.Right - d, rect.Bottom - d, d, d, 0, 90);
            path.AddArc(rect.X, rect.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    internal sealed class HeaderPanel : Panel
    {
        public HeaderPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (LinearGradientBrush brush = new LinearGradientBrush(ClientRectangle, Color.FromArgb(27, 29, 36), Color.FromArgb(32, 28, 34), 0f))
            {
                e.Graphics.FillRectangle(brush, ClientRectangle);
            }

            using (Pen line = new Pen(Color.FromArgb(90, Theme.Line), 1f))
            {
                e.Graphics.DrawLine(line, 0, Height - 1, Width, Height - 1);
            }

            using (Pen trace = new Pen(Color.FromArgb(70, Theme.Cyan), 1.4f))
            {
                int y = Height - 30;
                e.Graphics.DrawLine(trace, Width - 360, y, Width - 290, y);
                e.Graphics.DrawLine(trace, Width - 290, y, Width - 268, y - 14);
                e.Graphics.DrawLine(trace, Width - 268, y - 14, Width - 178, y - 14);
                e.Graphics.DrawLine(trace, Width - 178, y - 14, Width - 150, y + 4);
                e.Graphics.DrawLine(trace, Width - 150, y + 4, Width - 24, y + 4);
            }

            base.OnPaint(e);
        }
    }

    internal class DecoratedPanel : Panel
    {
        public DecoratedPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Theme.Panel;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? Theme.Background : Parent.BackColor);
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = DrawingUtil.RoundedRect(rect, 10))
            using (LinearGradientBrush fill = new LinearGradientBrush(rect, Theme.Panel, Color.FromArgb(22, 25, 30), 90f))
            using (Pen border = new Pen(Theme.Line, 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }

            using (Pen accent = new Pen(Color.FromArgb(120, Theme.Rose), 2f))
            {
                e.Graphics.DrawLine(accent, 18, 1, Math.Min(150, Width - 20), 1);
            }

            base.OnPaint(e);
        }
    }

    internal sealed class CommandDeckPanel : Panel
    {
        public CommandDeckPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Theme.Panel;
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? Theme.Background : Parent.BackColor);
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = DrawingUtil.RoundedRect(rect, 8))
            using (LinearGradientBrush fill = new LinearGradientBrush(rect, Color.FromArgb(246, 249, 249), Color.FromArgb(16, 26, 32), 0f))
            using (Pen border = new Pen(Color.FromArgb(120, Theme.Line), 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }

            using (SolidBrush dark = new SolidBrush(Color.FromArgb(222, 11, 17, 23)))
            {
                Point[] left = new Point[]
                {
                    new Point(0, 0),
                    new Point(Math.Min(Width, 520), 0),
                    new Point(Math.Min(Width, 460), Height),
                    new Point(0, Height)
                };
                e.Graphics.FillPolygon(dark, left);
            }

            using (Pen cyan = new Pen(Color.FromArgb(150, Theme.Cyan), 2f))
            using (Pen white = new Pen(Color.FromArgb(92, Color.White), 1f))
            using (Pen amber = new Pen(Color.FromArgb(145, Theme.Amber), 2f))
            {
                e.Graphics.DrawLine(cyan, 22, 14, 184, 14);
                e.Graphics.DrawLine(white, 23, 94, Math.Min(Width - 24, 430), 94);
                e.Graphics.DrawLine(amber, Math.Max(20, Width - 180), Height - 22, Width - 32, Height - 22);
                for (int x = Width - 260; x < Width - 40; x += 22)
                {
                    e.Graphics.DrawLine(white, x, 18, x + 10, 18);
                }
            }

            using (Pen grid = new Pen(Color.FromArgb(22, Theme.Cyan), 1f))
            {
                for (int x = 24; x < Width; x += 34)
                {
                    e.Graphics.DrawLine(grid, x, 104, x, Height - 18);
                }
                for (int y = 110; y < Height; y += 34)
                {
                    e.Graphics.DrawLine(grid, 18, y, Width - 18, y);
                }
            }

            base.OnPaint(e);
        }
    }

    internal sealed class LauncherActionLabel : Label
    {
        public Color AccentColor { get; set; }

        public LauncherActionLabel()
        {
            AccentColor = Theme.Cyan;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? Theme.Panel : Parent.BackColor);
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            bool enabled = Enabled;
            Color accent = enabled ? AccentColor : Theme.Line;

            using (GraphicsPath path = SlantedRect(rect, 12))
            using (LinearGradientBrush fill = new LinearGradientBrush(rect, Color.FromArgb(enabled ? 236 : 190, 16, 24, 31), Color.FromArgb(enabled ? 218 : 170, 31, 39, 47), 0f))
            using (Pen border = new Pen(Color.FromArgb(enabled ? 190 : 90, accent), 1.4f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }

            using (SolidBrush accentBrush = new SolidBrush(Color.FromArgb(enabled ? 230 : 100, accent)))
            {
                Point[] wedge = new Point[]
                {
                    new Point(0, 0),
                    new Point(42, 0),
                    new Point(26, Height - 1),
                    new Point(0, Height - 1)
                };
                e.Graphics.FillPolygon(accentBrush, wedge);
            }

            string text = Text.ToUpperInvariant();
            string index = text == "START" ? "01" : text == "STOP" ? "02" : text == "RESTART" ? "03" : "04";
            using (SolidBrush numberBrush = new SolidBrush(Color.FromArgb(enabled ? 245 : 130, Color.White)))
            using (SolidBrush textBrush = new SolidBrush(enabled ? Theme.Text : Color.FromArgb(140, Theme.Muted)))
            using (Font numberFont = new Font("Segoe UI", 8f, FontStyle.Bold))
            using (Font textFont = new Font("Segoe UI", text.Length > 6 ? 10.2f : 11.5f, FontStyle.Bold))
            using (StringFormat format = new StringFormat())
            {
                e.Graphics.DrawString(index, numberFont, numberBrush, 9, 8);
                format.Alignment = StringAlignment.Near;
                format.LineAlignment = StringAlignment.Center;
                format.Trimming = StringTrimming.EllipsisCharacter;
                format.FormatFlags = StringFormatFlags.NoWrap;
                e.Graphics.DrawString(text, textFont, textBrush, new RectangleF(50, 15, Width - 62, Height - 24), format);
            }

            DrawIcon(e.Graphics, text, accent, enabled);
        }

        private static GraphicsPath SlantedRect(Rectangle rect, int slant)
        {
            GraphicsPath path = new GraphicsPath();
            path.AddPolygon(new Point[]
            {
                new Point(rect.X + slant, rect.Y),
                new Point(rect.Right, rect.Y),
                new Point(rect.Right - slant, rect.Bottom),
                new Point(rect.X, rect.Bottom),
            });
            path.CloseFigure();
            return path;
        }

        private void DrawIcon(Graphics graphics, string text, Color accent, bool enabled)
        {
            int alpha = enabled ? 235 : 100;
            using (Pen pen = new Pen(Color.FromArgb(alpha, accent), 2.2f))
            using (SolidBrush brush = new SolidBrush(Color.FromArgb(alpha, accent)))
            {
                int x = Width - 34;
                int y = Height - 30;
                if (text == "START")
                {
                    graphics.FillPolygon(brush, new Point[] { new Point(x, y), new Point(x, y + 18), new Point(x + 15, y + 9) });
                }
                else if (text == "STOP")
                {
                    graphics.FillRectangle(brush, x, y + 3, 14, 14);
                }
                else if (text == "RESTART")
                {
                    graphics.DrawArc(pen, x - 2, y + 1, 18, 18, 30, 285);
                    graphics.FillPolygon(brush, new Point[] { new Point(x + 15, y + 2), new Point(x + 22, y + 2), new Point(x + 18, y + 9) });
                }
                else
                {
                    Point[] points = new Point[]
                    {
                        new Point(x - 2, y + 12),
                        new Point(x + 4, y + 12),
                        new Point(x + 7, y + 6),
                        new Point(x + 12, y + 18),
                        new Point(x + 16, y + 9),
                        new Point(x + 22, y + 9)
                    };
                    graphics.DrawLines(pen, points);
                }
            }
        }
    }

    internal sealed class MetricPanel : Panel
    {
        public MetricPanel()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? Theme.Panel : Parent.BackColor);
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = DrawingUtil.RoundedRect(rect, 8))
            using (SolidBrush fill = new SolidBrush(Theme.PanelStrong))
            using (Pen border = new Pen(Color.FromArgb(95, Theme.Line), 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
            base.OnPaint(e);
        }
    }

    internal sealed class CommandButton : Button
    {
        public Color AccentColor { get; set; }
        public string Caption { get; set; }

        public CommandButton()
        {
            AccentColor = Theme.Cyan;
            Caption = "";
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? Theme.Panel : Parent.BackColor);
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            Color top = Enabled ? Color.FromArgb(38, AccentColor) : Color.FromArgb(32, 34, 38);
            Color bottom = Enabled ? Theme.PanelStrong : Color.FromArgb(28, 30, 34);
            using (GraphicsPath path = DrawingUtil.RoundedRect(rect, 9))
            using (LinearGradientBrush fill = new LinearGradientBrush(rect, top, bottom, 90f))
            using (Pen border = new Pen(Enabled ? Color.FromArgb(130, AccentColor) : Color.FromArgb(80, Theme.Line), 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }

            using (Pen accent = new Pen(Enabled ? AccentColor : Theme.Line, 3f))
            {
                e.Graphics.DrawLine(accent, 14, 10, Width - 14, 10);
            }

            Color textColor = Enabled ? Theme.Text : Color.FromArgb(130, Theme.Muted);
            using (SolidBrush textBrush = new SolidBrush(textColor))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                format.Trimming = StringTrimming.EllipsisCharacter;
                e.Graphics.DrawString(Caption, Font, textBrush, rect, format);
            }
        }
    }

    internal sealed class MiniButton : Button
    {
        public MiniButton()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? Theme.Panel : Parent.BackColor);
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);
            using (GraphicsPath path = DrawingUtil.RoundedRect(rect, 8))
            using (SolidBrush fill = new SolidBrush(Theme.PanelStrong))
            using (Pen border = new Pen(Theme.Line, 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }
            using (SolidBrush textBrush = new SolidBrush(Theme.Text))
            using (StringFormat format = new StringFormat())
            {
                format.Alignment = StringAlignment.Center;
                format.LineAlignment = StringAlignment.Center;
                format.Trimming = StringTrimming.EllipsisCharacter;
                e.Graphics.DrawString(Text, Font, textBrush, rect, format);
            }
        }
    }

    internal sealed class BrandMark : Control
    {
        public BrandMark()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(2, 2, Width - 4, Height - 4);
            using (SolidBrush bg = new SolidBrush(Color.FromArgb(11, 13, 13)))
            using (Pen border = new Pen(Theme.Line, 1f))
            using (Pen teal = new Pen(Color.FromArgb(69, 197, 189), 4f))
            using (Pen green = new Pen(Theme.Green, 3f))
            using (SolidBrush amber = new SolidBrush(Color.FromArgb(242, 184, 75)))
            {
                e.Graphics.FillRectangle(bg, rect);
                e.Graphics.DrawRectangle(border, rect);
                teal.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                teal.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                green.StartCap = System.Drawing.Drawing2D.LineCap.Round;
                green.EndCap = System.Drawing.Drawing2D.LineCap.Round;
                e.Graphics.DrawArc(teal, 11, 18, Width - 22, Height, 205, 130);
                e.Graphics.DrawArc(green, 18, 31, Width - 36, Height - 8, 205, 130);
                e.Graphics.FillEllipse(amber, Width / 2 - 6, Height / 2 - 7, 12, 12);
            }
        }
    }

    internal sealed class MascotView : Control
    {
        private static readonly Image OperatorImage = LoadOperatorImage();

        public MascotView()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Theme.Panel;
        }

        private static Image LoadOperatorImage()
        {
            try
            {
                using (Stream stream = System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("operator-console.png"))
                {
                    if (stream == null)
                    {
                        return null;
                    }
                    using (Image loaded = Image.FromStream(stream))
                    {
                        return new Bitmap(loaded);
                    }
                }
            }
            catch
            {
                return null;
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle rect = new Rectangle(0, 0, Width - 1, Height - 1);

            if (OperatorImage != null)
            {
                PaintOperatorImage(e.Graphics, rect);
                return;
            }

            using (GraphicsPath path = DrawingUtil.RoundedRect(rect, 12))
            using (LinearGradientBrush fill = new LinearGradientBrush(rect, Color.FromArgb(19, 20, 25), Color.FromArgb(35, 29, 36), 35f))
            using (Pen border = new Pen(Color.FromArgb(105, Theme.Line), 1f))
            {
                e.Graphics.FillPath(fill, path);
                e.Graphics.DrawPath(border, path);
            }

            using (Pen grid = new Pen(Color.FromArgb(24, Theme.Cyan), 1f))
            {
                for (int x = 18; x < Width; x += 28)
                {
                    e.Graphics.DrawLine(grid, x, 12, x, Height - 12);
                }
                for (int y = 18; y < Height; y += 28)
                {
                    e.Graphics.DrawLine(grid, 12, y, Width - 12, y);
                }
            }

            int cx = Width / 2;
            int top = 22;
            Rectangle hairBack = new Rectangle(cx - 46, top + 6, 92, 86);
            using (SolidBrush hairDark = new SolidBrush(Color.FromArgb(116, 47, 64)))
            using (SolidBrush hairLight = new SolidBrush(Color.FromArgb(194, 83, 105)))
            using (SolidBrush skin = new SolidBrush(Color.FromArgb(232, 204, 194)))
            using (SolidBrush coat = new SolidBrush(Color.FromArgb(222, 226, 220)))
            using (SolidBrush shadow = new SolidBrush(Color.FromArgb(41, 35, 43)))
            using (Pen cyan = new Pen(Color.FromArgb(160, Theme.Cyan), 1.6f))
            using (Pen rose = new Pen(Color.FromArgb(170, Theme.Rose), 1.4f))
            {
                e.Graphics.FillEllipse(hairDark, hairBack);

                Point[] hair = new Point[]
                {
                    new Point(cx - 48, top + 50),
                    new Point(cx - 36, top + 10),
                    new Point(cx - 12, top),
                    new Point(cx + 8, top + 4),
                    new Point(cx + 36, top + 14),
                    new Point(cx + 50, top + 54),
                    new Point(cx + 34, top + 45),
                    new Point(cx + 18, top + 60),
                    new Point(cx - 8, top + 42),
                    new Point(cx - 28, top + 58)
                };
                e.Graphics.FillPolygon(hairLight, hair);

                Rectangle face = new Rectangle(cx - 28, top + 28, 56, 58);
                e.Graphics.FillEllipse(skin, face);

                e.Graphics.FillPie(hairDark, cx - 40, top + 18, 64, 42, 170, 185);
                e.Graphics.FillPie(hairLight, cx - 10, top + 15, 48, 34, 210, 160);

                e.Graphics.FillEllipse(new SolidBrush(Color.FromArgb(40, 53, 62)), cx - 18, top + 53, 8, 6);
                e.Graphics.FillEllipse(new SolidBrush(Color.FromArgb(52, 74, 78)), cx + 10, top + 53, 8, 6);
                e.Graphics.DrawLine(rose, cx - 4, top + 68, cx + 8, top + 68);

                Point[] body = new Point[]
                {
                    new Point(cx - 58, Height - 10),
                    new Point(cx - 30, top + 90),
                    new Point(cx + 30, top + 90),
                    new Point(cx + 58, Height - 10)
                };
                e.Graphics.FillPolygon(coat, body);
                e.Graphics.FillPolygon(shadow, new Point[] { new Point(cx - 16, top + 92), new Point(cx + 16, top + 92), new Point(cx + 28, Height - 10), new Point(cx - 28, Height - 10) });

                e.Graphics.DrawLine(cyan, 18, Height - 24, cx - 64, Height - 24);
                e.Graphics.DrawLine(cyan, cx + 64, Height - 24, Width - 18, Height - 24);
                e.Graphics.DrawLine(rose, 24, 22, 72, 22);
                e.Graphics.DrawLine(rose, Width - 72, 22, Width - 24, 22);
            }

            using (SolidBrush labelBrush = new SolidBrush(Color.FromArgb(185, Theme.Muted)))
            {
                e.Graphics.DrawString("AMADEUS NODE", new Font("Segoe UI", 7.5f, FontStyle.Bold), labelBrush, 14, Height - 22);
            }
        }

        private void PaintOperatorImage(Graphics graphics, Rectangle rect)
        {
            graphics.Clear(Parent == null ? Theme.Panel : Parent.BackColor);
            using (GraphicsPath clip = DrawingUtil.RoundedRect(rect, 12))
            using (Pen border = new Pen(Color.FromArgb(120, Theme.Line), 1f))
            {
                graphics.SetClip(clip);

                double destRatio = rect.Width / (double)Math.Max(1, rect.Height);
                double imageRatio = OperatorImage.Width / (double)Math.Max(1, OperatorImage.Height);
                Rectangle source;
                if (imageRatio > destRatio)
                {
                    int sourceWidth = (int)Math.Round(OperatorImage.Height * destRatio);
                    int sourceX = Math.Max(0, OperatorImage.Width - sourceWidth);
                    source = new Rectangle(sourceX, 0, sourceWidth, OperatorImage.Height);
                }
                else
                {
                    int sourceHeight = (int)Math.Round(OperatorImage.Width / destRatio);
                    int sourceY = Math.Max(0, (OperatorImage.Height - sourceHeight) / 2);
                    source = new Rectangle(0, sourceY, OperatorImage.Width, sourceHeight);
                }

                graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                graphics.DrawImage(OperatorImage, rect, source, GraphicsUnit.Pixel);

                using (SolidBrush shade = new SolidBrush(Color.FromArgb(88, 4, 8, 8)))
                {
                    graphics.FillRectangle(shade, rect);
                }

                using (Pen scan = new Pen(Color.FromArgb(30, Theme.Cyan), 1f))
                {
                    for (int y = 8; y < rect.Height; y += 6)
                    {
                        graphics.DrawLine(scan, 0, y, rect.Width, y);
                    }
                }

                graphics.ResetClip();
                graphics.DrawPath(border, clip);
            }

            using (SolidBrush labelBack = new SolidBrush(Color.FromArgb(168, 6, 9, 9)))
            using (Pen labelBorder = new Pen(Color.FromArgb(120, Theme.Cyan), 1f))
            using (SolidBrush green = new SolidBrush(Theme.Green))
            using (SolidBrush muted = new SolidBrush(Color.FromArgb(210, Theme.Muted)))
            {
                Rectangle label = new Rectangle(14, Height - 48, Math.Min(170, Width - 28), 34);
                using (GraphicsPath labelPath = DrawingUtil.RoundedRect(label, 8))
                {
                    graphics.FillPath(labelBack, labelPath);
                    graphics.DrawPath(labelBorder, labelPath);
                }
                graphics.DrawString("AMADEUS NODE", new Font("Segoe UI", 8f, FontStyle.Bold), green, label.X + 10, label.Y + 6);
                graphics.DrawString("local operator", new Font("Segoe UI", 7.2f, FontStyle.Regular), muted, label.X + 10, label.Y + 19);
            }
        }
    }

    internal sealed class SignalView : Control
    {
        public bool Running { get; set; }
        private readonly Stopwatch watch = Stopwatch.StartNew();

        public SignalView()
        {
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw | ControlStyles.UserPaint, true);
            BackColor = Color.FromArgb(9, 11, 11);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            e.Graphics.Clear(BackColor);

            using (Pen grid = new Pen(Color.FromArgb(24, 255, 255, 255), 1f))
            {
                for (int x = 0; x < Width; x += 24) e.Graphics.DrawLine(grid, x, 0, x, Height);
                for (int y = 0; y < Height; y += 24) e.Graphics.DrawLine(grid, 0, y, Width, y);
            }

            Color color = Running ? Theme.Green : Color.FromArgb(255, 98, 104);
            double time = watch.Elapsed.TotalSeconds;
            for (int lane = 0; lane < 3; lane++)
            {
                using (Pen pen = new Pen(Color.FromArgb(220 - lane * 45, color), 2f - lane * 0.35f))
                {
                    PointF? prev = null;
                    for (int x = 0; x < Width; x += 3)
                    {
                        double t = (double)x / Math.Max(1, Width);
                        double y = Height * (0.40 + lane * 0.13)
                            + Math.Sin(t * Math.PI * 6 + time * (1.2 + lane * 0.3)) * (14 - lane * 3)
                            + Math.Sin(t * Math.PI * 17 - time * 0.8) * 4;
                        PointF point = new PointF(x, (float)y);
                        if (prev.HasValue) e.Graphics.DrawLine(pen, prev.Value, point);
                        prev = point;
                    }
                }
            }
        }
    }
}
