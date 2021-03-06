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
var oscillatorStream;
var oscillatorStreamId;
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
var audioFileSelector;
var fileAudioElement;
var fileAudioStream;
// only used by players
var localVideoStreamRecorder;
var localVideoRecordedChunks = [];
var localAudioStreamRecorder;
var localAudioRecordedChunks = [];
var fileAudioStreamId;
var fileAudioGainNode;
var fileAudioSource;
var combinedStreamId;

var audioContext;
var playAudioDestination;
var recordAudioDestination;
var oscillatorDestination;

var playersMuted = false;
var muteStateBeforeRecording = false;
var playGainNodes = [];

const textHeight = parseFloat(window.getComputedStyle(document.body).fontSize) + 10;
var conductorViewPlayerVideoWidth = 100;
var conductorViewPlayerVideoHeight = 100;
var conductorViewPlayerVideoNumColumns = 6;
var conductorViewPlayerVideoNumRows = 4;

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
    if(e.isComposing || e.keyCode === 229) {
        return;
    }
    // M -> mute/unmute
    if(e.keyCode == 77) {
        mutePlayersButtonCallback();
    }
    // R -> start/stop recording (conductor only)
    else if(conductor && e.keyCode == 82) {
        startRecordingButtonCallback();
    }
    // space -> play audio file
    else if(conductor && e.keyCode == 32) {
        fileAudioElement.play();
    }
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
    oscillatorStream = null;
    oscillatorStreamId = null;
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

    audioContext = null;
    playAudioDestination = null;
    recordAudioDestination = null;
    oscillatorDestination = null;
    playersMuted = false;
    muteStateBeforeRecording = false;
    document.getElementById("mutePlayersButton").value = "Mute Players (M)";
    playGainNodes = [];

    audioFileSelector = null;
    fileAudioElement.src = "";
    fileAudioElement = null;
    fileAudioStream = null;
    fileAudioStreamId = null;
    fileAudioGainNode = null;
    fileAudioSource = null;
    document.getElementById("audioFileSelector").value = "";
    combinedStreamId = null;
}

/////////////////////////////////////////////////////////////////
//////////////// handle message from server /////////////////////
/////////////////////////////////////////////////////////////////
function gotMessageFromServer(fromId, message) {
    var signal = JSON.parse(message)
    // Make sure it's not coming from yourself
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
        if(signal.sync_stream_id) {
            oscillatorStreamId = signal.sync_stream_id;
            console.log("oscillatorStreamId: ", oscillatorStreamId);
        }
        if(signal.file_stream_id) {
            fileAudioStreamId = signal.file_stream_id;
            console.log("fileAudioStreamId: ", fileAudioStreamId);
        }
        if(signal.combined_stream_id) {
            combinedStreamId = signal.combined_stream_id;
            console.log("combinedStreamId: ", combinedStreamId);
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

/////////////////////////////////////////////////////////////////
/////////////////// beginning of session ////////////////////////
/////////////////////////////////////////////////////////////////
function startSession(debug_mode) {
    if(!debug_mode) {
        document.getElementById("localAudioDiv").style = "display:none";
    }
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
    if(oscillatorStream) {
        oscillatorStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
    if(fileAudioStream) {
        fileAudioStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
    localAudioElement.srcObject = null;
    // remove all videos except local
    if(conductor) {
        var div = document.querySelector(".conductorViewPlayerVideoDiv");
        while(div.hasChildNodes()) {
            div.removeChild(div.firstChild);
        }
        var linkDiv = document.getElementById("videoLinkDiv");
        while(linkDiv.hasChildNodes()) {
            linkDiv.removeChild(linkDiv.firstChild);
        }
        var selection = document.getElementById("playerVideoLayoutSelection");
        selection.disabled = false;
    }
    else {
        var div = document.querySelector(".playerViewConductorVideoDiv");
        while(div.hasChildNodes()) {
            div.removeChild(div.firstChild);
        }
        div = document.querySelector(".playerViewPlayerVideoDiv");
        while(div.hasChildNodes()) {
            div.removeChild(div.firstChild);
        }
    }
    if(socket) {
        socket.disconnect();
    }
    audioContext.close();
    reset();
}

function join() {
    statusText.innerHTML = "Connecting...";
    conductor = document.getElementById("conductorCheckbox").checked;
    if(conductor) {
        document.getElementById("conductorViewDiv").style.display = "block";
        audioFileSelector = document.getElementById("audioFileSelector");
        audioFileSelector.addEventListener("change", updateAudioFile);
        fileAudioElement = document.getElementById("fileAudio");
        fileAudioStream = fileAudioElement.captureStream();
        // set up player video layout
        var parent_div = document.querySelector('.conductorViewPlayerVideoDiv');
        var selection = document.getElementById("playerVideoLayoutSelection");
        selection.disabled = true;
        var layout_text = selection.value;
        console.log("layout: ", layout_text);
        var parent_width = parent_div.clientWidth;
        var parent_height = parent_div.clientHeight;
        if(layout_text == "one2one") {
            conductorViewPlayerVideoNumRows = 1;
            conductorViewPlayerVideoNumColumns = 1;
        }
        else if(layout_text == "small_chamb") {
            conductorViewPlayerVideoNumRows = 1;
            conductorViewPlayerVideoNumColumns = 5;
        }
        else if(layout_text == "large_chamb") {
            conductorViewPlayerVideoNumRows = 3;
            conductorViewPlayerVideoNumColumns = 4;
        }
        else if(layout_text == "string_orch") {
            conductorViewPlayerVideoNumRows = 4;
            conductorViewPlayerVideoNumColumns = 6;
        }
        else if(layout_text == "chamb_orch") {
            conductorViewPlayerVideoNumRows = 5;
            conductorViewPlayerVideoNumColumns = 8;
        }
        else if(layout_text == "full_orch") {
            conductorViewPlayerVideoNumRows = 6;
            conductorViewPlayerVideoNumColumns = 10;
        }
        conductorViewPlayerVideoWidth = parent_width / conductorViewPlayerVideoNumColumns;
        conductorViewPlayerVideoHeight = parent_height / conductorViewPlayerVideoNumRows;
        console.log("rows: ", conductorViewPlayerVideoNumRows, ", height: ", conductorViewPlayerVideoHeight, ", cols: ", conductorViewPlayerVideoNumColumns, ", width: ", conductorViewPlayerVideoWidth);
        parent_div.style.gridTemplateColumns = 'repeat(' + conductorViewPlayerVideoNumColumns.toString() + ', minmax(' + conductorViewPlayerVideoWidth.toString() + 'px, 1fr))';
        parent_div.style.gridTemplateRows = 'repeat(' + conductorViewPlayerVideoNumRows.toString() + ', minmax(' + conductorViewPlayerVideoHeight.toString() + 'px, 1fr))';
        // fill the grid with divs
        for(var i=0; i<conductorViewPlayerVideoNumRows; i++) {
            for(var j=0; j<conductorViewPlayerVideoNumColumns; j++) {
                var div_id = 'conductorViewPlayerNameVideoDiv_' + i.toString() + '_' + j.toString();
                if(document.getElementById(div_id) == null) {
                    var div = document.createElement('div');
                    var dragSourceDiv;
                    div.setAttribute('draggable', true);
                    div.setAttribute('class', 'conductorViewPlayerNameVideoDiv');
                    div.setAttribute('id', div_id);
                    div.addEventListener('dragstart', function(e) {
                        this.style.opacity = 0.4;
                        dragSourceDiv = this;
                    });
                    div.addEventListener('dragend', function(s) {
                        this.style.opacity = 1.0;
                        dragSourceDiv = null;
                        for(var k=0; k<parent_div.children.length; k++) {
                            parent_div.children[k].classList.remove('over');
                        }
                    });
                    div.addEventListener('dragover', function(e) {
                        if(e.preventDefault) {
                            e.preventDefault();
                        }
                    });
                    div.addEventListener('drop', function(e) {
                        e.stopPropagation();
                        console.log("dragDrop: ", this.id);
                        if(dragSourceDiv !== this) {
                            console.log("source: ", dragSourceDiv.id);
                            if(this.hasChildNodes()) {
                                // if this cell already has a video?
                            }
                            else {
                                while(dragSourceDiv.hasChildNodes()) {
                                    this.appendChild(dragSourceDiv.firstChild);
                                }
                            }
                        }
                        return false;
                    });
                    div.addEventListener('dragenter', function(e) {
                        this.classList.add('over');
                    });
                    div.addEventListener('dragleave', function(e) {
                        this.classList.remove('over');
                    });
                    parent_div.appendChild(div);
                }
            }
        }

//        fileAudioElement.addEventListener('canplay', function(e) {
        fileAudioElement.addEventListener('canplaythrough', function(e) {
            fileAudioStream = fileAudioElement.captureStream();
            fileAudioStream.getTracks().forEach(function(track) {
                console.log("track: ", track);
            });
            broadcastStream('file_stream_id', fileAudioStream);
        });

    }
    else {
        document.getElementById("playerViewDiv").style.display = "block";
    }
    localName = document.getElementById("nameText").value;
    console.log("joined: localName=" + localName + ", conductor=" + conductor);
    document.getElementById("joinButton").disabled = true;
    document.getElementById("leaveButton").disabled = false;

    localAudioElement = document.getElementById("localAudio");
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
            // create a common AudioContext and separate destinations for played and recorded streams
            audioContext = new AudioContext();
            playAudioDestination = audioContext.createMediaStreamDestination();
            recordAudioDestination = audioContext.createMediaStreamDestination();
            if(conductor) oscillatorDestination = audioContext.createMediaStreamDestination();

            // localAudioStream goes to record
            var localAudioSource = audioContext.createMediaStreamSource(localAudioStream);
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
                    localAudioElement.play();
                });
            });
            playAudioStream = playAudioDestination.stream;
            recordAudioStream = recordAudioDestination.stream;
            if(conductor) oscillatorStream = oscillatorDestination.stream;
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
                        // wait for other's video streams
                        connections[socketListId].onaddstream = function() {
                            gotRemoteStream(event, socketListId);
                        }
                        if(conductor) {
                            // conductor sends the track of the oscillatorStream
                            socket.emit('signal', socketListId, JSON.stringify({'sync_stream_id': oscillatorStream.id}));
                            console.log("sending oscillator stream to = ", socketListId, ", stream = ", oscillatorStream);
                            connections[socketListId].addStream(oscillatorStream);
                        }
                        // send the local video and audio streams
                        connections[socketListId].addStream(localVideoStream);
                        connections[socketListId].addStream(localAudioStream);

                        //send local name
                        socket.emit('signal', socketListId, JSON.stringify({'name': localName}));
                        // send conductor
                        if(conductor) {
                            socket.emit('signal', socketListId, JSON.stringify({'conductor': 'true'}));
                        }
                        else {
                            socket.emit('signal', socketListId, JSON.stringify({'conductor': 'false'}));
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
        console.log("gotRemoteStream: from = ", id, ", stream = ", event.stream);
        // process audio stream
        if(event.stream.getVideoTracks().length == 0) {
            // sync (oscillator) stream
            if(id == conductorId && event.stream.id == oscillatorStreamId) {
                console.log("this is sync audio");
                // add sync audio stream to record (and play)
                var rAudioElement = new Audio();
                rAudioElement.srcObject = event.stream;
                var rGainNode = audioContext.createGain();
                rGainNode.gain.value = 1.0;
                rAudioElement.onloadedmetadata = function() {
                    var rAudioSource = audioContext.createMediaStreamSource(rAudioElement.srcObject);
                    rAudioSource.connect(rGainNode);
                    rGainNode.connect(recordAudioDestination);
                    rGainNode.connect(playAudioDestination);  // to be removed?
                }
            }
            else if(id == conductorId && event.stream.id == fileAudioStreamId) {
                console.log("this is file audio");
                // add file audio stream to play
                if(fileAudioGainNode != null) {
                    fileAudioGainNode.disconnect();
                    fileAudioSource.disconnect();
                    console.log("previous stream removed");
                }
                var fAudioElement = new Audio();
                fAudioElement.srcObject = event.stream;
                fileAudioGainNode = audioContext.createGain();
                fileAudioGainNode.gain.value = 1.0;
                fAudioElement.onloadedmetadata = function() {
                    fileAudioSource = audioContext.createMediaStreamSource(fAudioElement.srcObject);
                    fileAudioSource.connect(fileAudioGainNode);
                    fileAudioGainNode.connect(playAudioDestination);
                }
            }
            else {
                console.log("this is audio");
                // add everything including conductor's to playAudio
                var audioElement = new Audio();
                audioElement.srcObject = event.stream;
                playGainNodes[id] = audioContext.createGain();
                playGainNodes[id].gain.value = 1.0;
                audioElement.onloadedmetadata = function() {
                    var audioSource = audioContext.createMediaStreamSource(audioElement.srcObject);
                    audioSource.connect(playGainNodes[id]);
                    playGainNodes[id].connect(playAudioDestination);
                }
            }
            return;
        }

        // combined video
        if(id == conductorId && event.stream.id == combinedStreamId) {
            console.log("this is combined video");
            if(confirm("Combined video received. Play?")) {
                var win = window.open("", "_blank");
                playCombinedVideoStream(win, event.stream);
            }
            return;
        }

        // live video
        // create the video and surrounding divs
        var video = document.createElement('video');
        var div = document.createElement('div');
        var nameDiv = document.createElement('div');
        video.setAttribute('data-socket', id);
        video.srcObject = event.stream;
        video.autoplay    = true;
        video.muted       = true;
        video.playsinline = true;
        var parent_div;

        if(conductor) {
            // remote stream must be a player
            video.className = 'conductorViewPlayerVideo';
            set_video_size(conductorViewPlayerVideoWidth, conductorViewPlayerVideoHeight - textHeight, video);
            nameDiv.innerHTML = '<input type=\"checkbox\" onclick=\"playerAudioMuteCallback(this)\" id=\"audio_' + id + '\" name=\"audioOnCheckbox\" checked>' + names[id];
            // find the first available cell
            for(var i=0; i<conductorViewPlayerVideoNumRows; i++) {
                for(var j=0; j<conductorViewPlayerVideoNumColumns; j++) {
                    var temp_div = document.getElementById('conductorViewPlayerNameVideoDiv_' + i.toString() + '_' + j.toString());
                    if(temp_div.children.length == 0) {
                        parent_div = temp_div;
                        break;
                    }
                }
                if(parent_div != null) break;
            }
            if(parent_div == null) {
                console.log("view is full");
            }
            else {
                console.log("parent_div found: ", parent_div.id);
            }
        }
        else {
            // player view
            if(id == conductorId) {
                video.className = 'playerViewConductorVideo';
                nameDiv.innerHTML = names[id];
                parent_div = document.querySelector('.playerViewConductorVideoDiv');
                var p_height = parent_div.getBoundingClientRect().height - textHeight;
                var p_width = parent_div.getBoundingClientRect().width;
                set_video_size(p_width, p_height, video);
            }
            else {
                video.className = 'playerViewPlayerVideo';
                nameDiv.innerHTML = '<input type=\"checkbox\" onclick=\"playerAudioMuteCallback(this, ' + id + ')\" id=\"audio_' + id + '\" name=\"audioOnCheckbox\" checked>' + names[id];
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

function playerAudioMuteCallback(checkbox) {
    var id = checkbox.id.substring(6);  // remove audio_
    if(checkbox.checked) {
        console.log("unmute player: ", id);
        playGainNodes[id].gain.value = 1.0;
    }
    else {
        console.log("mute player: ", id);
        playGainNodes[id].gain.value = 0.0;
    }
}

function conductorCheckboxClicked(checkbox) {
    var selection = document.getElementById("playerVideoLayoutSelection");
    if(checkbox.checked) {
        // allow choosing layout
        selection.disabled = false;
    }
    else {
        selection.disabled = true;
    }
}

/////////////////////////////////////////////////////////////////////////////////////
//////////////////////////////// conductor functions ////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////
function updateAudioFile() {
    if(audioFileSelector.files.length > 0) {
        console.log("audio file selected: ", audioFileSelector.files[0]);
        fileAudioElement.src = URL.createObjectURL(audioFileSelector.files[0]);
    }
}

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
        document.getElementById("startRecordingButton").value = "Start Recording (R)";
    }
    else {
        conductorStartRecording();
        Object.keys(connections).forEach(function(socketListId) {
            socket.emit('signal', socketListId, JSON.stringify({'recording': 'true'}));
        });
        document.getElementById("startRecordingButton").value = "Stop Recording (R)";
    }
}

function conductorStartRecording() {
    recording = true;
    statusText.innerHTML = "Recording";
    // mute audio from players
    muteStateBeforeRecording = playersMuted;
    if(!playersMuted) mutePlayersButtonCallback()

    // create oscillator for both streams
    var oscillator = audioContext.createOscillator();
    oscillator.type = "sine";
    oscillator.connect(playAudioDestination);  // to be removed?
    oscillator.connect(recordAudioDestination);
    oscillator.connect(oscillatorDestination);

    oscillator.frequency.value = 440;
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 2.0);

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
    // unmute player audio if it was not muted before recording
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
        statusText.innerHTML = "Connected";
        var url = window.URL.createObjectURL(blob);

        // TODO: connect blob's stream to players

        if(confirm("Processing completed. Play video?")) {
            var win = window.open("", "_blank");
            playCombinedVideoURL(win, url);
        }
    });

    ws.addEventListener('message', function(event) {
        byteChunks.push(event.data);
        console.log("message: received ", event.data.byteLength, " bytes");
    });
}

function playCombinedVideoURL(win, url) {
    var combinedVideoElement = win.document.createElement("video");
    combinedVideoElement.src = url;
    combinedVideoElement.autoplay = false;
    combinedVideoElement.muted = false;
    combinedVideoElement.playsinline = true;
    combinedVideoElement.controls = true;
    win.document.body.appendChild(combinedVideoElement);
    combinedVideoElement.addEventListener("canplay", event => {
        var combinedVideoStream = combinedVideoElement.captureStream();
        console.log("broadcast combined video stream: ", combinedVideoStream.id);
        broadcastStream("combined_stream_id", combinedVideoStream);
    });
}

function mutePlayersButtonCallback() {
    var keys = Object.keys(playGainNodes);
    const button = document.getElementById("mutePlayersButton");
    // unmute all players, except those without checks
    if(playersMuted) {
        keys.forEach(function(id) {
            if(id != conductorId) {
                var player_checkbox = document.getElementById("audio_" + id);
                if(player_checkbox.checked) {
                    console.log("unmuted ", id);
                    playGainNodes[id].gain.setValueAtTime(1.0, audioContext.currentTime);
                }
            }
        });
        button.value = "Mute Players (M)"
        playersMuted = false;
    }
    // mute all players
    else {
        keys.forEach(function(id) {
            if(id != conductorId) {
                console.log("muted ", id);
                playGainNodes[id].gain.setValueAtTime(0.0, audioContext.currentTime);
            }
        });
        button.value = "Unmute Players (M)"
        playersMuted = true;
    }
}

function broadcastStream(keyword, stream) {
    Object.keys(connections).forEach(function(socketListId) {
        if(socketListId != socketId) {
            var json_object = {};
            json_object[keyword] = stream.id;
            socket.emit('signal', socketListId, JSON.stringify(json_object));
            console.log("sending file audio stream to = ", socketListId, ", stream = ", stream);
            connections[socketListId].addStream(stream);
            connections[socketListId].createOffer().then(function(description) {
                connections[socketListId].setLocalDescription(description).then(function() {
                    socket.emit('signal', socketListId, JSON.stringify({'sdp': connections[socketListId].localDescription}));
                }).catch(e => console.log(e));
            });
        }
    });
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

function playCombinedVideoStream(win, stream) {
    var combinedVideoElement = win.document.createElement("video");
    combinedVideoElement.srcObject = stream;
    combinedVideoElement.autoplay = false;
    combinedVideoElement.muted = false;
    combinedVideoElement.playsinline = true;
    combinedVideoElement.controls = true;
    win.document.body.appendChild(combinedVideoElement);
}

