'use strict';

const videoSocketPort = 9001;
const allBlobsReadyEvent = new CustomEvent('all_blobs_ready');

const statusText = document.getElementById("statusText");

var localVideo;
var localAudioElement;
var localVideoStream;
var localAudioStream;
var playAudioStream;
var recordAudioStream;
var socketId;
var connections = [];
var socket;
var localName;
var names = [];
var conductor = false;
var conductorId;

var recording = false;
var recordingId = 0;
// only used by conductor
var blobsToSend = [];
// only used by players
var localVideoStreamRecorder;
var localVideoRecordedChunks = [];
var localAudioStreamRecorder;
var localAudioRecordedChunks = [];

var playAudioContext;
var recordAudioContext;
var playAudioDestination;
var recordAudioDestination;

var playersMuted = false;
var muteStateBeforeRecording = false;
var playGainNodes = [];

const textHeight = parseFloat(window.getComputedStyle(document.body).fontSize) + 10;
const conductorViewPlayerVideoWidth = 100;
const conductorViewPlayerVideoHeight = 100;

const constraints = {
    video: true,
    audio: {
        autoGainControl: false,
        noiseSuppression: false,
        echoCancellation: false,
        latency: {ideal: 0.01, max: 0.1},
        channelCount: {ideal: 2, min: 1}
    }
};

var peerConnectionConfig = {
    'iceServers': [
        {'urls': 'stun:stun.l.google.com:19302'},
        {'urls': 'stun:stun1.l.google.com:19302'},
        {'urls': 'stun:stun2.l.google.com:19302'},
        {'urls': 'stun:stun3.l.google.com:19302'},
        {'urls': 'stun:stun4.l.google.com:19302'},
        {'urls': 'stun:stun.services.mozilla.com:3478'},
    ]
};

function keyboardCallback(e) {
}

// set the video size of aspect ratio 4:3 such that it fits within (max_w, max_h)
function set_video_size(max_w, max_h, video) {
    var h_w_ratio = 0.75;  // default aspect ratio 4:3
    var h_from_w = max_w * h_w_ratio;
    if(h_from_w > max_h) {
        video.height = max_h;
        video.width = max_h / h_w_ratio;
    }
    else {
        video.width = max_w;
        video.height = max_w * h_w_ratio;
    }
}

function userLeft(id) {
    var keys = Object.keys(playGainNodes);
    var index = keys.findIndex(key => key == id);
    playGainNodes[id].disconnect();
    playGainNodes.splice(index, 1);
    keys = Object.keys(connections);
    index = keys.findIndex(key => key == id);
    connections.splice(index, 1);
    keys = Object.keys(names);
    index = keys.findIndex(key => key == id);
    names.splice(index, 1);
}

function reset() {
//    document.getElementById("nameText").value = "Your Name";
//    document.getElementById("conductorCheckbox").checked = false;
    if(recording) {
        // stop recording and release buffer and file
        if(conductor) {
            conductorStopRecording();
        }
        else {
            stopRecordingCommand();
        }
    }
    statusText.innerHTML = "Disconnected";
    document.getElementById("conductorViewDiv").style = "display:none";
    document.getElementById("playerViewDiv").style = "display:none";
    document.getElementById("joinButton").disabled = false;
    document.getElementById("leaveButton").disabled = true;
    localVideo = null;
    localAudioElement = null;
    localVideoStream = null;
    localAudioStream = null;
    playAudioStream = null;
    recordAudioStream = null;
    socketId = null;
    connections = [];
    socket = null;
    localName = null;
    names = [];
    conductor = false;
    conductorId = null;
    recording = false;
    recordingId = 0;
    blobsToSend = [];
    localVideoStreamRecorder = null;
    localAudioStreamRecorder = null;
    localVideoRecordedChunks = [];
    localAudioRecordedChunks = [];

    playAudioContext = null;
    recordAudioContext = null;
    playAudioDestination = null;
    recordAudioDestination = null;
    playersMuted = false;
    muteStateBeforeRecording = false;
    document.getElementById("mutePlayersButton").value = "Mute Players";
    playGainNodes = [];
}

function gotMessageFromServer(fromId, message) {
    //Parse the incoming signal
    var signal = JSON.parse(message)
    //Make sure it's not coming from yourself
    if(fromId != socketId) {
//        console.log("gotMessageFromServer: " + fromId + ", " + message);
        console.log("gotMessageFromServer: " + fromId);
        if(signal.name) {
            names[fromId] = signal.name;
        }
        if(signal.recording) {
            // should be a player if receiving this
            if(signal.recording == 'true') {
                // start recording
                startRecordingCommand();
            }
            if(signal.recording == 'false') {
                // stop recording
                stopRecordingCommand();
            }
        }
        if(signal.conductor) {
            if(signal.conductor == 'true') {
                if(conductor) {
                    // TODO: resolve conflict
                    alert("There are multiple conductors!");
                }
                else {
                    conductorId = fromId;
                }
            }
        }
        if(signal.sdp) {
            connections[fromId].setRemoteDescription(new RTCSessionDescription(signal.sdp)).then(function() {
                if(signal.sdp.type == 'offer') {
                    connections[fromId].createAnswer().then(function(description) {
                        connections[fromId].setLocalDescription(description).then(function() {
                            socket.emit('signal', fromId, JSON.stringify({'sdp': connections[fromId].localDescription}));
                        }).catch(e => console.log(e));
                    }).catch(e => console.log(e));
                }
            }).catch(e => console.log(e));
        }
        if(signal.ice) {
            try {
                connections[fromId].addIceCandidate(new RTCIceCandidate(signal.ice));
            }
            catch(e) {
                console.log(e + ", " + message);
            }
        }
    }
}

/////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////// conductor functions ////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////
// "Start Recording" button callback
// should be called only from the conductor
function startRecordingButtonCallback() {
    if(recording) {
        conductorStopRecording();
        // prepare receiving video data
        synchronizeVideos();
        // stop recording at players
        Object.keys(connections).forEach(function(socketListId) {
            socket.emit('signal', socketListId, JSON.stringify({'recording': 'false'}));
        });
        document.getElementById("startRecordingButton").value = "Start Recording";
    }
    else {
        conductorStartRecording();
        Object.keys(connections).forEach(function(socketListId) {
            socket.emit('signal', socketListId, JSON.stringify({'recording': 'true'}));
        });
        document.getElementById("startRecordingButton").value = "Stop Recording";
    }
}

function conductorStartRecording() {
    // TODO: indicate recording
    statusText.innerHTML = "Recording";
    muteStateBeforeRecording = playersMuted;
    if(!playersMuted) mutePlayersButtonCallback()

    recording = true;

    // add oscillation
    console.log("currentTime = ", recordAudioContext.currentTime);

    // create oscillator and connect to both streams
    var playOscillator = playAudioContext.createOscillator();
    playOscillator.type = "sine";
    playOscillator.connect(playAudioDestination);
    var recordOscillator = recordAudioContext.createOscillator();
    recordOscillator.type = "sine";
    recordOscillator.connect(recordAudioDestination);

    playOscillator.frequency.value = 440;
    recordOscillator.frequency.value = 440;
    playOscillator.start();
    recordOscillator.start();
    playOscillator.stop(playAudioContext.currentTime + 2.0);
    recordOscillator.stop(recordAudioContext.currentTime + 2.0);

    // set up the event to notify that all videos are ready for sending to servlet
    var dummyDiv = document.getElementById("dummyDiv");
    if(dummyDiv == null) {
        dummyDiv = document.createElement("div");
        dummyDiv.id = "dummyDiv";
        document.body.appendChild(dummyDiv);
    }
    dummyDiv.addEventListener('all_blobs_ready', sendBlobsToServlet);
    // record local stream
    localVideoStreamRecorder = new MediaRecorder(localVideoStream, {mimeType: 'video/webm'});
    localAudioStreamRecorder = new MediaRecorder(recordAudioStream, {mimeType: 'audio/webm'});
    localVideoRecordedChunks = [];
    localAudioRecordedChunks = [];
    localVideoStreamRecorder.addEventListener('dataavailable', function(e) {
        if(e.data.size > 0) {
            localVideoRecordedChunks.push(e.data);
        }
    });
    localAudioStreamRecorder.addEventListener('dataavailable', function(e) {
        if(e.data.size > 0) {
            localAudioRecordedChunks.push(e.data);
        }
    });
    localVideoStreamRecorder.addEventListener('stop', function() {
        var key = socketId + "_video";
        blobsToSend[key] = new Blob(localVideoRecordedChunks);
        console.log("conductor video size: ", blobsToSend[key].size);
        if(Object.keys(blobsToSend).length == 2 * Object.keys(connections).length) {
            console.log("all blobs are ready (1): ", Object.keys(blobsToSend).length);
            var dummyDiv = document.getElementById("dummyDiv");
            dummyDiv.dispatchEvent(allBlobsReadyEvent);
        }
    });
    localAudioStreamRecorder.addEventListener('stop', function() {
        var key = socketId + "_audio";
        blobsToSend[key] = new Blob(localAudioRecordedChunks);
        console.log("conductor audio size: ", blobsToSend[key].size);
        if(Object.keys(blobsToSend).length == 2 * Object.keys(connections).length) {
            console.log("all blobs are ready (2): ", Object.keys(blobsToSend).length);
            var dummyDiv = document.getElementById("dummyDiv");
            dummyDiv.dispatchEvent(allBlobsReadyEvent);
        }
    });
    localVideoStreamRecorder.start();
    localAudioStreamRecorder.start();
}

function conductorStopRecording() {
    recording = false;
    statusText.innerHTML = "Receiving videos...";
    // stop recording
    localVideoStreamRecorder.stop();
    localAudioStreamRecorder.stop();
    // TODO: stop indicating recording
    if(!muteStateBeforeRecording) mutePlayersButtonCallback()
}

function receiveLocalVideo(fromId, buffer) {
    var key = fromId + "_video";
    blobsToSend[key] = new Blob([buffer], {type: 'video/webm'});
    console.log("received local video from ", fromId, ": size = ", blobsToSend[key].size);
    if(Object.keys(blobsToSend).length == 2 * Object.keys(connections).length) {
        console.log("all blobs are ready (3): ", Object.keys(blobsToSend).length);
        var dummyDiv = document.getElementById("dummyDiv");
        dummyDiv.dispatchEvent(allBlobsReadyEvent);
    }
}

function receiveLocalAudio(fromId, buffer) {
    var key = fromId + "_audio";
    blobsToSend[key] = new Blob([buffer], {type: 'audio/webm'});
    console.log("received local audio from ", fromId, ": size = ", blobsToSend[key].size);
    if(Object.keys(blobsToSend).length == 2 * Object.keys(connections).length) {
        console.log("all blobs are ready (4): ", Object.keys(blobsToSend).length);
        var dummyDiv = document.getElementById("dummyDiv");
        dummyDiv.dispatchEvent(allBlobsReadyEvent);
    }
}

// send video data to Java through socket
function sendBlobsToServlet() {
    var dummyDiv = document.getElementById("dummyDiv");
    dummyDiv.addEventListener('prev_blob_sent', e => sendBlobToServlet(e.detail));
    dummyDiv.dispatchEvent(new CustomEvent('prev_blob_sent', {detail: 0}));
}

function sendBlobToServlet(index) {
    var keys = Object.keys(blobsToSend);
    if(index >= keys.length) {
        var dummyDiv = document.getElementById("dummyDiv");
        dummyDiv.parentElement.removeChild(dummyDiv);
        blobsToSend = [];
        recordingId = recordingId + 1;
        // now receive combined video
        receiveBlobFromServlet();
        return;
    }
    console.log("sendBlobToServlet(", index, ")");
    var ws_url = "ws://localhost:" + videoSocketPort;
    var role = null;
    var name = null;
    var media = null;
    var id = null;
    var n = keys[index].search("_video");
    if(n >= 0) {
        id = keys[index].substring(0, n);
        media = "video";
    }
    else {
        n = keys[index].search("_audio");
        id = keys[index].substring(0, n);
        media = "audio";
    }
    // conductor
    if(keys[index].search(socketId) >= 0) {
        role = 'conductor';
        name = localName;
    }
    else {
        role = 'player';
        name = names[id];
    }
    console.log("sending blob from ", id, ": media = ", media, ", role = ", role, ", name = ", name, ", size = ", blobsToSend[keys[index]].size);
    var ws = new WebSocket(ws_url);
    console.log("websocket created");
    ws.addEventListener('open', function(event) {
        console.log("opened");
        var msg = {
            name: name,
            id: id,
            role: role,
            media: media,
        };
        ws.send(JSON.stringify(msg));

        blobsToSend[keys[index]].arrayBuffer().then(function(buffer) {
            var view = new Uint8Array(buffer);
            console.log("sending view ...");
            ws.send(view);
            console.log("completed");
            ws.close();
            var dummyDiv = document.getElementById("dummyDiv");
            dummyDiv.dispatchEvent(new CustomEvent('prev_blob_sent', {detail: index+1}));
        });
    });
}

function synchronizeVideos() {
    statusText.innerHTML = "Processing videos...";
    var ids = Object.keys(connections);
    var n = ids.lastIndexOf(conductorId);
    ids.splice(n, 1);

    console.log("synchronizeVideos: ", videoSocketPort, ", ", conductorId, ", ", ids);
    $.ajax({
        type: "POST",
        url: "synchronize_videos",
        traditional: true,
        data: {
            port: videoSocketPort,
            conductor: conductorId,
            players: ids,
            recording: recordingId,
        },

        async: true,
        cache: false,
        timeout: 10000, // Timeout in ms

        success: function (data) {
            console.log("success");
	},
        error: function(XMLHttpRequest, textStatus, errorThrown) {
            alert("video processing error: " + errorThrown);
            console.log("Status: " + textStatus);
            console.log("Error: " + errorThrown);
        }
    });
}

function receiveBlobFromServlet() {
    console.log("receiveBlobFromServlet");
    var ws_url = "ws://localhost:" + videoSocketPort;
    var ws = new WebSocket(ws_url);
    ws.binaryType = 'arraybuffer';
    var byteChunks = [];
    console.log("websocket created");

    ws.addEventListener('open', function(event) {
        console.log("websocket opened");
    });

    ws.addEventListener('error', function(event) {
        console.log("websocket error: ", event);
    });

    ws.addEventListener('close', function() {
        var blob = new Blob(byteChunks, {type: 'video/webm'});
        console.log("received video size: ", blob.size);
        var url = window.URL.createObjectURL(blob);

        statusText.innerHTML = "Processing completed; <a id=\'combinedVideoLink\' href=\'" + url + "\' target=\'_blank\'>click</a> to open";
        var combinedVideoLink = document.getElementById("combinedVideoLink");
        combinedVideoLink.onclick = function() {
            statusText.innerHTML = "Connected";
        };

/*
        var videoWindow = window.open("", "_blank");
        console.log(videoWindow);
        var video = document.createElement('video');
        var videoDiv = document.createElement("div");
        var linkDiv = document.createElement("div");
        videoDiv.style = "text-align:center;";
        linkDiv.style = "text-align:center;";
        video.src = url;
        video.autoplay    = true;
        video.muted       = false;
        video.playsinline = true;
        video.controls = true;
        video.height = 240;
        video.width = 320;
        var videoLink = document.createElement("a");
        videoLink.href = url;
        videoLink.innerHTML = "Save Video";
        videoLink.download = "default.webm";
        videoWindow.document.body.appendChild(videoDiv);
        videoWindow.document.body.appendChild(linkDiv);
        videoDiv.appendChild(video);
        linkDiv.appendChild(videoLink);
*/
    });

    ws.addEventListener('message', function(event) {
        byteChunks.push(event.data);
        console.log("message: received ", event.data.byteLength, " bytes");
    });
}

function mutePlayersButtonCallback() {
    var keys = Object.keys(playGainNodes);
    const button = document.getElementById("mutePlayersButton");
    if(playersMuted) {
        keys.forEach(function(id) {
            if(id != conductorId) {
                console.log("unmuted ", id);
                playGainNodes[id].gain.setValueAtTime(1.0, playAudioContext.currentTime);
            }
        });
        button.value = "Mute Players"
        playersMuted = false;
    }
    else {
        keys.forEach(function(id) {
            if(id != conductorId) {
                console.log("muted ", id);
                playGainNodes[id].gain.setValueAtTime(0.0, playAudioContext.currentTime);
            }
        });
        button.value = "Unmute Players"
        playersMuted = true;
    }
}

/////////////////////////////////////////////////////////////////////////////////////
////////////////////////////////// player functions /////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////
function playerStartRecording() {
    localVideoStreamRecorder = new MediaRecorder(localVideoStream, {mimeType: 'video/webm'});
    localAudioStreamRecorder = new MediaRecorder(recordAudioStream, {mimeType: 'audio/webm'});
    localVideoRecordedChunks = [];
    localAudioRecordedChunks = [];

    localVideoStreamRecorder.addEventListener('dataavailable', function(e) {
        if(e.data.size > 0) {
            localVideoRecordedChunks.push(e.data);
        }
    });
    localAudioStreamRecorder.addEventListener('dataavailable', function(e) {
        if(e.data.size > 0) {
            localAudioRecordedChunks.push(e.data);
        }
    });

    localVideoStreamRecorder.addEventListener('stop', function() {
        var blob = new Blob(localVideoRecordedChunks);
        // send through socket
        console.log("sending local video of size ", blob.size, " ...");
        blob.arrayBuffer().then(function(buffer) {
            console.log("buffer size: ", buffer.byteLength);
            socket.emit('video-blob', conductorId, buffer)
        });
        console.log("video done");
    });
    localAudioStreamRecorder.addEventListener('stop', function() {
        var blob = new Blob(localAudioRecordedChunks);
        // send through socket
        console.log("sending local audio of size ", blob.size, " ...");
        blob.arrayBuffer().then(function(buffer) {
            console.log("buffer size: ", buffer.byteLength);
            socket.emit('audio-blob', conductorId, buffer)
        });
        console.log("audio done");
    });

    localVideoStreamRecorder.start();
    localAudioStreamRecorder.start();
}

function startRecordingCommand() {
    // TODO: indicate recording
    statusText.innerHTML = "Recording";
    muteStateBeforeRecording = playersMuted;
    if(!playersMuted) mutePlayersButtonCallback()
    recording = true;
    playerStartRecording();
}

function stopRecordingCommand() {
    recording = false;
    statusText.innerHTML = "Connected";
    // stop recording
    localVideoStreamRecorder.stop();
    localAudioStreamRecorder.stop();
    // TODO: stop indicating recording
    if(!muteStateBeforeRecording) mutePlayersButtonCallback()
}

function startSession() {
    document.addEventListener('keydown', keyboardCallback);

    // check if all required functions are available
    if('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices) {
        var audioInputSelection = document.getElementById("audioInputSelection");
        var videoInputSelection = document.getElementById("videoInputSelection");
        var audioOutputSelection = document.getElementById("audioOutputSelection");
        navigator.mediaDevices.enumerateDevices()
            .then(function(devices) {
                devices.forEach(function(device) {
                    console.log(device.kind + ": " + device.label + " id = " + device.deviceId);
                    if(device.kind == "audioinput") {
                        var option = document.createElement("option");
                        option.text = device.label;
                        option.value = device.deviceId;
                        audioInputSelection.add(option);
                    }
                    else if(device.kind == "videoinput") {
                        var option = document.createElement("option");
                        option.text = device.label;
                        option.value = device.deviceId;
                        videoInputSelection.add(option);
                    }
                    else if(device.kind == "audiooutput") {
                        var option = document.createElement("option");
                        option.text = device.label;
                        option.value = device.deviceId;
                        audioOutputSelection.add(option);
                    }
                });
            });
    }
    else {
        alert("Sorry, your browser does not support mediaDevices() and/or getUserMedia()");
        document.getElementById("joinButton").disabled = true;
    }
}

function leave() {
    statusText.innerHTML = "Leaving...";
    if(localVideoStream) {
        localVideoStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
    if(playAudioStream) {
        playAudioStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
    if(localAudioStream) {
        localAudioStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
    if(recordAudioStream) {
        recordAudioStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
    localAudioElement.srcObject = null;
    // remove all videos except local
    if(conductor) {
        var div = document.querySelector(".conductorViewPlayerVideoDiv");
        var c = div.children;
        for(var i=0; i<c.length; i++) {
            div.removeChild(c[i]);
        }
        var linkDiv = document.getElementById("videoLinkDiv");
        var linkc = linkDiv.children;
        for(var i=0; i<linkc.length; i++) {
            linkDiv.removeChild(linkc[i]);
        }
    }
    else {
        var div = document.querySelector(".playerViewConductorVideoDiv");
        var c = div.children;
        for(var i=0; i<c.length; i++) {
            div.removeChild(c[i]);
        }
        div = document.querySelector(".playerViewPlayerVideoDiv");
        c = div.children;
        for(var i=0; i<c.length; i++) {
            div.removeChild(c[i]);
        }
    }
    if(socket) {
        socket.disconnect();
    }
    reset();
}

function join() {
    statusText.innerHTML = "Connecting...";
    conductor = document.getElementById("conductorCheckbox").checked;
    if(conductor) {
        document.getElementById("conductorViewDiv").style.display = "block";
    }
    else {
        document.getElementById("playerViewDiv").style.display = "block";
    }
    localName = document.getElementById("nameText").value;
    console.log("joined: localName=" + localName + ", conductor=" + conductor);
    document.getElementById("joinButton").disabled = true;
    document.getElementById("leaveButton").disabled = false;

    localAudioElement = document.getElementById("localAudio");
    console.log("localAudioElement: ", localAudioElement);
    if(conductor) {
        localVideo = document.getElementById("conductorViewLocalVideo");
    }
    else {
        localVideo = document.getElementById("playerViewLocalVideo");
    }
    localVideo.oncanplay = setupSocket;
    async function startStream() {
        // extract the chosen video device
        var videoInputSelection = document.getElementById("videoInputSelection");
        var videoSource = videoInputSelection.value;
        if(videoSource == "none") videoSource = "default";
        console.log("videoSource: ", videoSource);
        const videoConstraints = {
            video: {deviceId: videoSource},
            audio: false
        };
        try {
            const stream = await navigator.mediaDevices.getUserMedia(videoConstraints);
            getUserMediaSuccess(stream);
        }
        catch(e) {
            console.log("getUserMedia failed: " + e);
        }
    }

    function getUserMediaSuccess(stream) {
        localVideoStream = stream;
        // set audio input
        var audioInputSelection = document.getElementById("audioInputSelection");
        var audioSource = audioInputSelection.value;
        if(audioSource == "none") audioSource = "default";
        console.log("audioSource: ", audioSource);
        const audioConstraints = {
            video: false,
            audio: {
                deviceId: audioSource,
                autoGainControl: false,
                noiseSuppression: false,
                echoCancellation: false,
                latency: {ideal: 0.01, max: 0.1},
                channelCount: {ideal: 2, min: 1}
            }
        };

        navigator.mediaDevices.getUserMedia(audioConstraints).then(function(audioStream) {
            var parent_div = localVideo.parentElement;
            var div_height = parent_div.getBoundingClientRect().height - textHeight;
            var div_width = parent_div.getBoundingClientRect().width;
            set_video_size(div_width, div_height, localVideo);
            localVideo.srcObject = stream;

            localAudioStream = audioStream;
            // AudioContexts and destinations for played and recorded streams
            playAudioContext = new AudioContext();
            recordAudioContext = new AudioContext();
            playAudioDestination = playAudioContext.createMediaStreamDestination();
            recordAudioDestination = recordAudioContext.createMediaStreamDestination();

            // localAudioStream goes to record
            var localAudioSource = recordAudioContext.createMediaStreamSource(localAudioStream);
            localAudioSource.connect(recordAudioDestination);

            if(conductor) {
                document.getElementById("conductorViewLocalNameDiv").innerHTML = localName;
            }
            else {
                document.getElementById("playerViewLocalNameDiv").innerHTML = localName;
            }
            // set audio output
            var audioOutputSelection = document.getElementById("audioOutputSelection");
            var audioDest = audioOutputSelection.value;
            if(audioDest == "none") audioDest = "default";
            console.log("audioDest: ", audioDest);
            localAudioElement.setSinkId(audioDest).then(() => {
                localAudioElement.srcObject = playAudioDestination.stream;
                localAudioElement.addEventListener("canplay", event => {
                    console.log("localAudioElement.play()");
                    console.log("readyState (0): ", localAudioElement.readyState);
                    localAudioElement.play();
                });
            });
            playAudioStream = playAudioDestination.stream;
            recordAudioStream = recordAudioDestination.stream;
        });
    }

    function setupSocket() {
        socket = io.connect(config.host, {secure: true});
//        socket = io.connect(config.host, {rejectUnauthorized: false, secure: true});
        socket.on('signal', gotMessageFromServer);
        socket.on('connect', onConnect);
        socket.on('video-blob', receiveLocalVideo);
        socket.on('audio-blob', receiveLocalAudio);

        statusText.innerHTML = "Connected";

        function onConnect() {
            socketId = socket.id;
            console.log("onConnect: socketId = " + socketId);
            // send my name
            names[socketId] = localName;
            if(conductor) conductorId = socketId;
            socket.on('user-left', function(id) {
                console.log("user-left: " + id);
                var video = document.querySelector('[data-socket="'+ id +'"]');
                var parentDiv = video.parentElement;
                video.parentElement.parentElement.removeChild(parentDiv);
                userLeft(id);
            });
            socket.on('user-joined', function(id, count, clients) {
                console.log("user-joined: " + id + ", " + count + ", " + clients);
                clients.forEach(function(socketListId) {
                    if(!connections[socketListId]) {
                        connections[socketListId] = new RTCPeerConnection(peerConnectionConfig);
                        //Wait for their ice candidate
                        connections[socketListId].onicecandidate = function() {
                            if(event.candidate != null) {
                                socket.emit('signal', socketListId, JSON.stringify({'ice': event.candidate}));
                            }
                        }
                        //Wait for their video stream
                        connections[socketListId].onaddstream = function() {
                            gotRemoteStream(event, socketListId)
                        }
                        //Add the local video stream
                        connections[socketListId].addStream(localVideoStream);
                        //send local name
                        socket.emit('signal', socketListId, JSON.stringify({'name': localName}));
                        // send conductor
                        if(conductor) {
                            socket.emit('signal', socketListId, JSON.stringify({'conductor': 'true'}));
                            // conductor sends recordAudioStream (=local+sync)
                            connections[socketListId].addStream(recordAudioStream);
                        }
                        else {
                            socket.emit('signal', socketListId, JSON.stringify({'conductor': 'false'}));
                            // players send localAudioStream
                            connections[socketListId].addStream(localAudioStream);
                        }
                    }
                });
                //Create an offer to connect with your local description
                if(count >= 2) {
                    connections[id].createOffer().then(function(description) {
                        connections[id].setLocalDescription(description).then(function() {
                            socket.emit('signal', id, JSON.stringify({'sdp': connections[id].localDescription}));
                        }).catch(e => console.log(e));
                    });
                }
            });
        }
    }

    function gotRemoteStream(event, id) {
        console.log("gotRemoteStream: " + event + ", " + id);
        // process audio stream
        if(event.stream.getVideoTracks().length == 0) {
            if(id == conductorId) {
                // add conductor's audio (record) stream to record
                var rAudioElement = new Audio();
                rAudioElement.srcObject = event.stream;
                var rGainNode = recordAudioContext.createGain();
                rGainNode.gain.value = 1.0;  // reduce gain for record?
                rAudioElement.onloadedmetadata = function() {
                    var rAudioSource = recordAudioContext.createMediaStreamSource(rAudioElement.srcObject);
                    rAudioSource.connect(rGainNode);
                    rGainNode.connect(recordAudioDestination);
                }
            }
            // add everything including conductor's to playAudio
            var audioElement = new Audio();
            audioElement.srcObject = event.stream;
            playGainNodes[id] = playAudioContext.createGain();
            playGainNodes[id].gain.value = 1.0;
            audioElement.onloadedmetadata = function() {
                var audioSource = playAudioContext.createMediaStreamSource(audioElement.srcObject);
                audioSource.connect(playGainNodes[id]);
                playGainNodes[id].connect(playAudioDestination);
            }
            return;
        }

        // create the video and surrounding divs
        var video = document.createElement('video');
        var div = document.createElement('div');
        var nameDiv = document.createElement('div');
        video.setAttribute('data-socket', id);
        video.srcObject = event.stream;
        video.autoplay    = true;
        video.muted       = true;
        video.playsinline = true;
        nameDiv.innerHTML = names[id];
        var parent_div;

        if(conductor) {
            // remote stream must be a player
            video.className = 'conductorViewPlayerVideo';
            parent_div = document.querySelector('.conductorViewPlayerVideoDiv');
            set_video_size(conductorViewPlayerVideoWidth, conductorViewPlayerVideoHeight, video);
        }
        else {
            // player view
            if(id == conductorId) {
                video.className = 'playerViewConductorVideo';
                parent_div = document.querySelector('.playerViewConductorVideoDiv');
                var p_height = parent_div.getBoundingClientRect().height - textHeight;
                var p_width = parent_div.getBoundingClientRect().width;
                set_video_size(p_width, p_height, video);
            }
            else {
                video.className = 'playerViewPlayerVideo';
                var n_player_videos = Object.keys(connections).length - 1;
                if(conductorId) {
                    n_player_videos = n_player_videos - 1;
                }
                parent_div = document.querySelector('.playerViewPlayerVideoDiv');
                var p_height = parent_div.getBoundingClientRect().height - textHeight;
                var p_width = parent_div.getBoundingClientRect().width;
                var v_width = p_width / n_player_videos;
                set_video_size(v_width, p_height, video);
            }
        }
        div.appendChild(video);
        div.appendChild(nameDiv);
        parent_div.appendChild(div);
    }
    /////////////////////////////////////////
    startStream();
}

