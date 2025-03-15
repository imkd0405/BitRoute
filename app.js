// WebRTC objects
let peerConnection;
let dataChannel;
let fileReader;
let receivedBuffers = [];
let fileSize = 0;
let receivedSize = 0;
let metadata = null;
let isInitiator = false;
let filesToSend = [];
let sendProgress = 0;
let transferInProgress = false;

const CHUNK_SIZE = 65536;

// UI elements
const status = document.getElementById('status');
const progressContainer = document.getElementById('progressContainer');
const signalBox = document.getElementById('signalBox');
const dropZone = document.getElementById('dropZone');
const downloadLink = document.getElementById('downloadLink');

// Toggle Dark/Light Mode with persistence
const toggleDarkLightMode = () => {
    const body = document.body;
    body.classList.toggle('light-mode');
    body.classList.toggle('dark-mode');

    // Persist the mode in localStorage
    const isLightMode = body.classList.contains('light-mode');
    localStorage.setItem('theme', isLightMode ? 'light' : 'dark');
};

// Apply saved theme on page load
document.addEventListener('DOMContentLoaded', () => {
    const savedTheme = localStorage.getItem('theme');
    const body = document.body;
    if (savedTheme === 'light') {
        body.classList.add('light-mode');
        body.classList.remove('dark-mode');
    } else if (savedTheme === 'dark') {
        body.classList.add('dark-mode');
        body.classList.remove('light-mode');
    }
});

// Fade-In Animation for Title
const fadeInText = (element) => {
    if (!element) return;
    const text = element.textContent;
    element.textContent = '';
    let index = 0;
    const interval = setInterval(() => {
        if (index < text.length) {
            element.textContent += text[index];
            index++;
        } else {
            clearInterval(interval);
        }
    }, 100);
};

// Apply fade-in to the title
if (document.querySelector('h1')) {
    fadeInText(document.querySelector('h1'));
}

// Handle file drop
if (dropZone) {
    dropZone.addEventListener('click', () => {
        document.getElementById('fileInput').click();
    });

    dropZone.addEventListener('dragover', (event) => {
        event.preventDefault();
        dropZone.style.borderColor = '#0056b3';
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.style.borderColor = '#007bff';
    });

    dropZone.addEventListener('drop', (event) => {
        event.preventDefault();
        dropZone.style.borderColor = '#007bff';
        const files = event.dataTransfer.files;
        if (files.length > 0) {
            document.getElementById('fileInput').files = files;
            handleFiles(files);
        }
    });

    document.getElementById('fileInput').addEventListener('change', (event) => {
        const files = event.target.files;
        handleFiles(files);
    });
}

// Handle multiple files and display progress bars
function handleFiles(files) {
    if (transferInProgress) {
        status.textContent = 'Transfer in progress. Please wait before adding more files.';
        return;
    }

    filesToSend = Array.from(files);
    progressContainer.innerHTML = ''; // Clear previous progress bars
    filesToSend.forEach((file, index) => {
        const fileProgress = document.createElement('div');
        fileProgress.className = 'file-progress';
        fileProgress.innerHTML = `
            <span>${file.name}</span>
            <progress id="progress-${index}" value="0" max="${file.size}"></progress>
            <span class="percentage">0%</span>
        `;
        progressContainer.appendChild(fileProgress);
    });
    status.textContent = `${filesToSend.length} file(s) selected. Connect to a peer and start the transfer.`;
    downloadLink.style.display = 'none'; // Hide download link until a file is received
}

// Compress SDP - FIXED to properly handle problematic lines
function compressSignal(sdp) {
    // Keep the original SDP but filter out the problematic line
    const minimalSdp = {
        type: sdp.type,
        sdp: sdp.sdp
            .split('\n')
            .filter(line => !line.includes('a=max-message-size:'))
            .join('\n')
    };
    return minimalSdp;
}

// Decompress SDP
function decompressSignal(minSdp) {
    return new RTCSessionDescription(minSdp);
}

// Start WebRTC connection (Initiator)
function startConnection() {
    if (peerConnection) {
        peerConnection.close();
    }

    peerConnection = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            // Added more STUN servers for better connectivity
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ]
    });

    dataChannel = peerConnection.createDataChannel('fileTransfer', {
        ordered: true,
        maxRetransmits: 30
    });

    isInitiator = true;
    setupDataChannel();

    peerConnection.onicegatheringstatechange = () => {
        if (peerConnection.iceGatheringState === 'complete') {
            const compressedSignal = compressSignal(peerConnection.localDescription);
            signalBox.value = JSON.stringify(compressedSignal);
            status.textContent = 'Copy this offer and send it to your peer.';
        }
    };

    peerConnection.onicecandidate = (event) => {
        if (event.candidate === null) {
            const compressedSignal = compressSignal(peerConnection.localDescription);
            signalBox.value = JSON.stringify(compressedSignal);
            status.textContent = 'Copy this offer and send it to your peer.';
        }
    };

    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'failed') {
            status.textContent = 'Connection failed. Please try again or check your network.';
        } else if (peerConnection.connectionState === 'connected') {
            status.textContent = 'Connection established! Ready to transfer files.';
        } else if (peerConnection.connectionState === 'disconnected') {
            status.textContent = 'Connection lost. Attempting to reconnect...';
            // Added basic reconnection attempt
            setTimeout(() => {
                if (peerConnection.connectionState === 'disconnected') {
                    status.textContent = 'Unable to reconnect. Please start a new connection.';
                }
            }, 5000);
        }
    };

    peerConnection.createOffer()
        .then(offer => {
            console.log('Generated offer:', offer);
            return peerConnection.setLocalDescription(offer);
        })
        .catch(err => {
            console.error('Error creating offer:', err);
            status.textContent = `Error creating offer: ${err.message}`;
        });
}

// Connect to peer (Responder or final handshake)
function connectPeer() {
    try {
        const signalData = JSON.parse(signalBox.value.trim());

        if (!signalData || !signalData.type) {
            status.textContent = 'Please enter valid signaling data.';
            return;
        }

        if (!peerConnection) {
            peerConnection = new RTCPeerConnection({
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { urls: 'stun:stun2.l.google.com:19302' },
                    // Added more STUN servers for better connectivity
                    { urls: 'stun:stun3.l.google.com:19302' },
                    { urls: 'stun:stun4.l.google.com:19302' }
                ]
            });

            peerConnection.onicegatheringstatechange = () => {
                if (peerConnection.iceGatheringState === 'complete') {
                    const compressedSignal = compressSignal(peerConnection.localDescription);
                    signalBox.value = JSON.stringify(compressedSignal);
                    status.textContent = 'Copy this answer and send it back to the initiator.';
                }
            };

            peerConnection.onicecandidate = (event) => {
                if (event.candidate === null) {
                    const compressedSignal = compressSignal(peerConnection.localDescription);
                    signalBox.value = JSON.stringify(compressedSignal);
                    status.textContent = 'Copy this answer and send it back to the initiator.';
                }
            };

            peerConnection.onconnectionstatechange = () => {
                console.log('Connection state:', peerConnection.connectionState);
                if (peerConnection.connectionState === 'failed') {
                    status.textContent = 'Connection failed. Please try again or check your network.';
                } else if (peerConnection.connectionState === 'connected') {
                    status.textContent = 'Connection established! Ready to transfer files.';
                } else if (peerConnection.connectionState === 'disconnected') {
                    status.textContent = 'Connection lost. Attempting to reconnect...';
                    // Added basic reconnection attempt
                    setTimeout(() => {
                        if (peerConnection.connectionState === 'disconnected') {
                            status.textContent = 'Unable to reconnect. Please start a new connection.';
                        }
                    }, 5000);
                }
            };
        }

        if (signalData.type === 'offer') {
            isInitiator = false;

            peerConnection.ondatachannel = event => {
                dataChannel = event.channel;
                setupDataChannel();
            };

            console.log('Setting remote description with offer:', signalData);
            peerConnection.setRemoteDescription(decompressSignal(signalData))
                .then(() => {
                    console.log('Remote description set successfully. Creating answer...');
                    return peerConnection.createAnswer();
                })
                .then(answer => {
                    console.log('Answer created:', answer);
                    return peerConnection.setLocalDescription(answer);
                })
                .catch(err => {
                    console.error('Error handling offer:', err);
                    status.textContent = `Error handling offer: ${err.message}`;
                });
        } else if (signalData.type === 'answer' && isInitiator) {
            console.log('Setting remote description with answer:', signalData);
            peerConnection.setRemoteDescription(decompressSignal(signalData))
                .then(() => {
                    status.textContent = 'Connection established! Ready to transfer files.';
                })
                .catch(err => {
                    console.error('Error setting answer:', err);
                    status.textContent = `Error setting answer: ${err.message}`;
                });
        } else {
            status.textContent = 'Invalid signal data or wrong connection state.';
        }
    } catch (err) {
        console.error('Error parsing signal data:', err);
        status.textContent = 'Invalid signal data format. Please check and try again.';
    }
}

// Setup data channel
function setupDataChannel() {
    dataChannel.binaryType = 'arraybuffer';

    dataChannel.onopen = () => {
        console.log("Data channel opened successfully!");
        status.textContent = 'Connected! Select a file to send or wait to receive.';
        transferInProgress = false;
    };

    dataChannel.onmessage = receiveChunk;

    dataChannel.onclose = () => {
        console.log("Data channel closed");
        status.textContent = 'Connection closed. Start a new connection to transfer files.';
        transferInProgress = false;
        progressContainer.innerHTML = '';
        filesToSend = [];
    };

    dataChannel.onerror = (err) => {
        console.error(`Data channel error: ${err}`);
        status.textContent = `Data channel error: ${err.message}`;
        transferInProgress = false;
    };
}

// Cancel ongoing transfer
function cancelTransfer() {
    if (transferInProgress) {
        transferInProgress = false;
        if (fileReader) {
            fileReader.abort();
        }
        status.textContent = 'Transfer cancelled.';
        // Clear incomplete progress
        progressContainer.innerHTML = '';
        filesToSend = [];
    }
}

// Start file transfer
function startTransfer() {
    if (!dataChannel || dataChannel.readyState !== 'open') {
        status.textContent = 'Connection not ready. Please connect to a peer first.';
        return;
    }

    if (filesToSend.length === 0) {
        status.textContent = 'No files selected. Please add files to transfer.';
        return;
    }

    if (transferInProgress) {
        status.textContent = 'A transfer is already in progress. Please wait.';
        return;
    }

    transferInProgress = true;
    sendNextFile(0);
}

// Send files sequentially
function sendNextFile(index) {
    if (index >= filesToSend.length) {
        status.textContent = 'All files sent successfully!';
        transferInProgress = false;
        return;
    }

    const file = filesToSend[index];
    fileSize = file.size;
    const progress = document.getElementById(`progress-${index}`);
    const percentage = progress.nextElementSibling;
    progress.max = fileSize;
    progress.value = 0;
    sendProgress = 0;

    status.textContent = `Sending ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)...`;

    dataChannel.send(JSON.stringify({ name: file.name, size: file.size }));

    fileReader = new FileReader();
    let offset = 0;

    fileReader.onload = (e) => {
        if (!transferInProgress) return; // Stop if transfer was canceled
        dataChannel.send(e.target.result);
        offset += e.target.result.byteLength;
        progress.value = offset;
        sendProgress = Math.floor((offset / fileSize) * 100);
        percentage.textContent = `${sendProgress}%`;

        if (sendProgress % 10 === 0) {
            status.textContent = `Sending ${file.name}: ${sendProgress}% complete`;
        }

        if (offset < fileSize) {
            // Flow control to prevent buffer overflow
            if (dataChannel.bufferedAmount > 1024 * 1024) {
                setTimeout(() => readSlice(offset), 100);
            } else {
                readSlice(offset);
            }
        } else {
            status.textContent = `File sent: ${file.name}`;
            sendNextFile(index + 1);
        }
    };

    fileReader.onerror = (err) => {
        console.error('FileReader error:', err);
        status.textContent = `Error reading file: ${err.message}`;
        transferInProgress = false;
    };

    const readSlice = (offset) => {
        if (!transferInProgress) return;
            const slice = file.slice(offset, Math.min(offset + CHUNK_SIZE, fileSize));
        fileReader.readAsArrayBuffer(slice);
    };

    readSlice(0);
}

// Receive file chunks
function receiveChunk(event) {
    try {
        if (typeof event.data === 'string') {
            metadata = JSON.parse(event.data);
            fileSize = metadata.size;
            status.textContent = `Receiving ${metadata.name} (${(fileSize / (1024 * 1024)).toFixed(2)} MB)...`;
            const fileProgress = document.createElement('div');
            fileProgress.className = 'file-progress';
            fileProgress.innerHTML = `
                <span>${metadata.name}</span>
                <progress value="0" max="${fileSize}"></progress>
                <span class="percentage">0%</span>
            `;
            progressContainer.appendChild(fileProgress);
            receivedBuffers = [];
            receivedSize = 0;
            return;
        }

        receivedBuffers.push(event.data);
        receivedSize += event.data.byteLength;
        const lastProgress = progressContainer.lastElementChild.querySelector('progress');
        const lastPercentage = progressContainer.lastElementChild.querySelector('.percentage');
        lastProgress.value = receivedSize;

        const receivedPercent = Math.floor((receivedSize / fileSize) * 100);
        lastPercentage.textContent = `${receivedPercent}%`;
        if (receivedPercent % 10 === 0 && receivedPercent > 0) {
            status.textContent = `Receiving ${metadata.name}: ${receivedPercent}% complete`;
        }

        if (receivedSize === fileSize && metadata) {
            const blob = new Blob(receivedBuffers);
            const url = URL.createObjectURL(blob);
            downloadLink.href = url;
            downloadLink.download = metadata.name;
            downloadLink.style.display = 'block';
            downloadLink.textContent = `Download ${metadata.name}`;
            status.textContent = 'File received successfully!';
            
            // Added notification for received file
            if (Notification && Notification.permission === 'granted') {
                new Notification('File Transfer Complete', {
                    body: `${metadata.name} has been received successfully!`,
                    icon: '/favicon.ico'
                });
            }
            
            receivedBuffers = [];
            receivedSize = 0;
        }
    } catch (error) {
        console.error("Error processing received data:", error);
        status.textContent = `Error processing data: ${error.message}`;
        transferInProgress = false;
    }
}

// Check connection status
function checkConnectionStatus() {
    if (!peerConnection) {
        status.textContent = 'No connection established. Please start a connection first.';
        return false;
    }
    
    const connectionState = peerConnection.connectionState;
    const dataChannelState = dataChannel ? dataChannel.readyState : 'closed';
    
    status.textContent = `Connection state: ${connectionState}, Data channel: ${dataChannelState}`;
    
    return connectionState === 'connected' && dataChannelState === 'open';
}

// Request notification permission
function requestNotificationPermission() {
    if (Notification && Notification.permission !== 'granted') {
        Notification.requestPermission();
    }
}

// Clean up resources
function cleanUp() {
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
    }
    
    if (dataChannel) {
        dataChannel.close();
        dataChannel = null;
    }
    
    // Clean up file reader if active
    if (fileReader) {
        fileReader.abort();
        fileReader = null;
    }
    
    // Release object URLs
    if (downloadLink.href) {
        URL.revokeObjectURL(downloadLink.href);
        downloadLink.href = '';
        downloadLink.style.display = 'none';
    }
    
    // Reset state variables
    receivedBuffers = [];
    fileSize = 0;
    receivedSize = 0;
    metadata = null;
    isInitiator = false;
    filesToSend = [];
    sendProgress = 0;
    transferInProgress = false;
    
    status.textContent = 'Connection cleaned up. Ready to start a new session.';
    progressContainer.innerHTML = '';
}

// Make functions available in the window scope
window.startConnection = startConnection;
window.connectPeer = connectPeer;
window.startTransfer = startTransfer;
window.cancelTransfer = cancelTransfer;
window.toggleDarkLightMode = toggleDarkLightMode;
window.checkConnectionStatus = checkConnectionStatus;
window.requestNotificationPermission = requestNotificationPermission;
window.cleanUp = cleanUp;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Request notification permission if supported
    if (Notification) {
        requestNotificationPermission();
    }
    
    // Add cancel button if not already present in HTML
    if (!document.getElementById('cancelButton')) {
        const cancelButton = document.createElement('button');
        cancelButton.id = 'cancelButton';
        cancelButton.className = 'btn btn-danger';
        cancelButton.textContent = 'Cancel Transfer';
        cancelButton.onclick = cancelTransfer;
        cancelButton.style.display = 'none'; // Hide initially
        
        // Add it near the start transfer button
        const startButton = document.querySelector('button[onclick="startTransfer()"]');
        if (startButton && startButton.parentNode) {
            startButton.parentNode.insertBefore(cancelButton, startButton.nextSibling);
        }
    }
});
// Create a new Lucide icon for beetroot
(() => {
  // Register custom beetroot icon
  const beetIcon = {
    name: 'beet',
    toSvg: (attrs = {}) => {
      const { width = 24, height = 24, ...rest } = attrs;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${width}" height="${height}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${Object.entries(rest).map(([key, val]) => `${key}="${val}"`).join(' ')}>
        <path d="M12 2v4" />
        <path d="M18 4c-2 1.5-4 0-6 2" />
        <path d="M12 7a5 5 0 0 0-5 5c0 2 1 3 2 4a8 8 0 0 0 6 0c1-1 2-2 2-4a5 5 0 0 0-5-5z" />
        <path d="M6 4c2 1.5 4 0 6 2" />
        <path d="M9 20c-2 2-5-1-4-4" />
        <path d="M15 20c2 2 5-1 4-4" />
        <path d="M12 19v3" />
      </svg>`;
    }
  };

  // If Lucide is loaded, register the icon
  if (typeof lucide !== 'undefined') {
    lucide.icons.beet = beetIcon;
  }
})();

// Apply the beetroot icon to the logo when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  // Create icons
  lucide.createIcons();
  
  // Apply beetroot icon specifically to the logo element
  const beetrootLogo = document.getElementById("beetroot-logo");
  if (beetrootLogo) {
    beetrootLogo.innerHTML = lucide.createIcon("beet", { 
      size: 24,
      // The color will automatically inherit from CSS based on theme
      'stroke-width': 2
    }).outerHTML;
  }
});
