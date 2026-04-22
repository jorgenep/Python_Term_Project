# Phase 3 Project

This phase of the project runs object detection using a TensorFlow Lite model (`detect.tflite`). It supports running on both standard computers (x86_64) and ARM devices (like a Raspberry Pi 4).

## Project Structure

* `main.py` - Main application code.
* `detect.tflite` - TensorFlow Lite object detection model.
* `labelmap.txt` - Labels corresponding to the classes detected by the model.
* `requirements.txt` - Project dependencies.

## Setup Instructions

### 1. Create and Activate a Virtual Environment

It is highly recommended to use a virtual environment (`venv`) to keep your dependencies isolated.

**On Linux/macOS:**
```bash
# Navigate to the project directory
cd Python_Term_Project

# Create the virtual environment
# Use --copies to avoid broken shebangs on immutable distros (Bazzite, Silverblue, etc.)
python3 -m venv venv --copies

# Activate the virtual environment
source venv/bin/activate
```

**On Windows:**
```cmd
# Navigate to the phase-3 directory
cd phase-3

# Create the virtual environment
python -m venv venv

# Activate the virtual environment
venv\Scripts\activate
```

### 2. Configure Dependencies (x86 vs ARM Processors)

The project relies on a TensorFlow Lite runtime, but the specific package you need changes depending on your processor architecture.

**If you are on an x86/x64 processor (Standard Windows/Linux/Mac PC):**
By default, the `requirements.txt` file is set up for x86 processors using the `ai-edge-litert` package. You don't need to change anything.

**If you are on an ARM processor (e.g., Raspberry Pi):**
You must edit the `requirements.txt` file before installing dependencies. 
1. Open `requirements.txt`.
2. Delete or comment out the `ai-edge-litert` line.
3. Uncomment the `tflite-runtime` line at the bottom.

### 3. Install Dependencies

Once your `requirements.txt` is configured for your platform and your virtual environment is activated, install the required packages:

```bash
pip install -r requirements.txt
```

### 4. Run the Project

With the dependencies installed, start the application using the provided launcher script.
On Bazzite, this script automatically detects whether you launched it from the host shell or
from the VS Code Flatpak terminal, then chooses the correct runtime:

```bash
./run.sh
```

Activating the venv first is optional when using `run.sh`:

```bash
bash run.sh
```