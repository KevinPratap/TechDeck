# Long-running helper for PocketDeck: Windows volume, per-app volume and brightness.
# Reads one JSON command per line on stdin, writes one JSON reply per line on stdout.
#   {"id":1,"cmd":"getMaster"}  ->  {"id":1,"ok":true,"v":0.42,"mute":false}
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace PD {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}

  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
  }

  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }

  [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioEndpointVolume {
    int RegisterControlChangeNotify(IntPtr n);
    int UnregisterControlChangeNotify(IntPtr n);
    int GetChannelCount(out int c);
    int SetMasterVolumeLevel(float db, ref Guid ctx);
    int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
    int GetMasterVolumeLevel(out float db);
    int GetMasterVolumeLevelScalar(out float level);
    int SetChannelVolumeLevel(uint ch, float db, ref Guid ctx);
    int SetChannelVolumeLevelScalar(uint ch, float level, ref Guid ctx);
    int GetChannelVolumeLevel(uint ch, out float db);
    int GetChannelVolumeLevelScalar(uint ch, out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  [ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionManager2 {
    int GetAudioSessionControl(IntPtr g, uint f, out IntPtr c);
    int GetSimpleAudioVolume(IntPtr g, uint f, out IntPtr v);
    int GetSessionEnumerator(out IAudioSessionEnumerator e);
  }

  [ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionEnumerator {
    int GetCount(out int n);
    int GetSession(int i, out IAudioSessionControl2 s);
  }

  [ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioSessionControl2 {
    int GetState(out int s);
    int GetDisplayName(out IntPtr n);
    int SetDisplayName(IntPtr n, ref Guid c);
    int GetIconPath(out IntPtr p);
    int SetIconPath(IntPtr p, ref Guid c);
    int GetGroupingParam(out Guid g);
    int SetGroupingParam(ref Guid o, ref Guid c);
    int RegisterAudioSessionNotification(IntPtr n);
    int UnregisterAudioSessionNotification(IntPtr n);
    int GetSessionIdentifier(out IntPtr id);
    int GetSessionInstanceIdentifier(out IntPtr id);
    int GetProcessId(out uint pid);
    int IsSystemSoundsSession();
    int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool b);
  }

  [ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISimpleAudioVolume {
    int SetMasterVolume(float level, ref Guid ctx);
    int GetMasterVolume(out float level);
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
    int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
  }

  public class SessionInfo {
    public int Pid;
    public string Name;
    public double Volume;
    public bool Mute;
  }

  public static class Audio {
    static Guid none = Guid.Empty;
    static Guid IID_Endpoint = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
    static Guid IID_Sessions = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");

    static IMMDevice Device() {
      var en = (IMMDeviceEnumerator)new MMDeviceEnumeratorCom();
      IMMDevice dev;
      Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev)); // render, multimedia
      return dev;
    }

    static IAudioEndpointVolume Endpoint() {
      object o;
      Marshal.ThrowExceptionForHR(Device().Activate(ref IID_Endpoint, 23, IntPtr.Zero, out o));
      return (IAudioEndpointVolume)o;
    }

    public static double GetMaster() { float v; Marshal.ThrowExceptionForHR(Endpoint().GetMasterVolumeLevelScalar(out v)); return v; }
    public static void SetMaster(double v) { Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar((float)v, ref none)); }
    public static bool GetMute() { bool m; Marshal.ThrowExceptionForHR(Endpoint().GetMute(out m)); return m; }
    public static void SetMute(bool m) { Marshal.ThrowExceptionForHR(Endpoint().SetMute(m, ref none)); }

    static List<IAudioSessionControl2> Controls() {
      object o;
      Marshal.ThrowExceptionForHR(Device().Activate(ref IID_Sessions, 23, IntPtr.Zero, out o));
      IAudioSessionEnumerator en;
      Marshal.ThrowExceptionForHR(((IAudioSessionManager2)o).GetSessionEnumerator(out en));
      int n;
      en.GetCount(out n);
      var list = new List<IAudioSessionControl2>();
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2 c;
        if (en.GetSession(i, out c) == 0) list.Add(c);
      }
      return list;
    }

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    // Name of the program whose window is in front, e.g. "obs64".
    public static string Foreground() {
      var h = GetForegroundWindow();
      if (h == IntPtr.Zero) return "";
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      return NameOf(pid);
    }

    static string NameOf(uint pid) {
      if (pid == 0) return "System sounds";
      try { return Process.GetProcessById((int)pid).ProcessName; } catch { return "pid " + pid; }
    }

    public static List<SessionInfo> Sessions() {
      var res = new List<SessionInfo>();
      foreach (var c in Controls()) {
        uint pid; c.GetProcessId(out pid);
        var vol = (ISimpleAudioVolume)c;
        float v; bool m;
        vol.GetMasterVolume(out v);
        vol.GetMute(out m);
        res.Add(new SessionInfo { Pid = (int)pid, Name = NameOf(pid), Volume = v, Mute = m });
      }
      return res;
    }

    // All sessions whose process name matches (a program can have several).
    static List<ISimpleAudioVolume> ForApp(string app) {
      var res = new List<ISimpleAudioVolume>();
      foreach (var c in Controls()) {
        uint pid; c.GetProcessId(out pid);
        if (string.Equals(NameOf(pid), app, StringComparison.OrdinalIgnoreCase)) res.Add((ISimpleAudioVolume)c);
      }
      if (res.Count == 0) throw new Exception("No audio from \"" + app + "\" right now. Start playing something in it.");
      return res;
    }

    public static double GetApp(string app) { float v; ForApp(app)[0].GetMasterVolume(out v); return v; }
    public static bool GetAppMute(string app) { bool m; ForApp(app)[0].GetMute(out m); return m; }
    public static void SetApp(string app, double v) { foreach (var s in ForApp(app)) s.SetMasterVolume((float)v, ref none); }
    public static void SetAppMute(string app, bool m) { foreach (var s in ForApp(app)) s.SetMute(m, ref none); }
  }
}
'@

function Reply($id, $obj) {
  $obj['id'] = $id
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
}

function Invoke-Cmd($c) {
  switch ($c.cmd) {
    'getMaster'  { return @{ ok = $true; v = [PD.Audio]::GetMaster(); mute = [PD.Audio]::GetMute() } }
    'setMaster'  { [PD.Audio]::SetMaster([double]$c.v); return @{ ok = $true } }
    'setMute'    { [PD.Audio]::SetMute([bool]$c.mute); return @{ ok = $true } }
    'sessions'   { return @{ ok = $true; sessions = @([PD.Audio]::Sessions() | ForEach-Object { @{ pid = $_.Pid; name = $_.Name; v = $_.Volume; mute = $_.Mute } }) } }
    'getApp'     { return @{ ok = $true; v = [PD.Audio]::GetApp($c.app); mute = [PD.Audio]::GetAppMute($c.app) } }
    'setApp'     { [PD.Audio]::SetApp($c.app, [double]$c.v); return @{ ok = $true } }
    'setAppMute' { [PD.Audio]::SetAppMute($c.app, [bool]$c.mute); return @{ ok = $true } }
    'foreground' { return @{ ok = $true; process = [PD.Audio]::Foreground() } }
    'getBrightness' {
      $b = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
      return @{ ok = $true; v = $b.CurrentBrightness / 100 }
    }
    'setBrightness' {
      $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1
      Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte][math]::Round($c.v * 100) } | Out-Null
      return @{ ok = $true }
    }
    default { throw "unknown command $($c.cmd)" }
  }
}

[Console]::Out.WriteLine('{"ready":true}')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  if (-not $line.Trim()) { continue }
  $id = $null
  try {
    $c = $line | ConvertFrom-Json
    $id = $c.id
    Reply $id (Invoke-Cmd $c)
  } catch {
    $msg = $_.Exception.Message
    if ($_.Exception.InnerException) { $msg = $_.Exception.InnerException.Message }
    Reply $id @{ ok = $false; error = $msg }
  }
}
