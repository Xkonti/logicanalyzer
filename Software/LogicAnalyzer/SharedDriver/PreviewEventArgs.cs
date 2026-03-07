using System;

namespace SharedDriver
{
    public class PreviewEventArgs : EventArgs
    {
        public required byte[][] Samples { get; set; }
        public required AnalyzerChannel[] Channels { get; set; }
    }
}
