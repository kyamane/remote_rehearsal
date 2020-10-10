'use strict';

const videoSocketPort = 9000;
const allVideosReadyEvent = new CustomEvent('all_videos_ready');

var localVideo;
var localStream;
var socketId;
var connections = [];
var socket;
var localName;
var names = [];
var conductor = false;
var conductorId;

var recording = false;
// only used by conductor
var blobsToSend = [];
// only used by players
var localStreamRecorder;
var localRecordedChunks = [];
var conductorStream;

var syncAudioTrackId;

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

function reset() {
//    document.getElementById("nameText").value = "Your Name";
//    document.getElementById("conductorCheckbox").checked = false;
    if(recording) {
        // stop recording and release buffer and file
        if(conductor) {
            conductorStopRecording();
        }
        else {
            playerStopRecording();
        }
    }

    document.getElementById("conductorViewDiv").style = "display:none";
    document.getElementById("playerViewDiv").style = "display:none";
    document.getElementById("joinButton").disabled = false;
    document.getElementById("leaveButton").disabled = true;
    localVideo = null;
    localStream = null;
    socketId = null;
    connections = [];
    socket = null;
    localName = null;
    names = [];
    conductor = false;
    conductorId = null;
    recording = false;
    blobsToSend = [];
    localStreamRecorder = null;
    localRecordedChunks = [];
    conductorStream = null;
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
        if(signal.sync) {
            syncAudioTrackId = signal.sync;
            console.log("syncAudioTrackId: ", syncAudioTrackId);
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
    // TODO: mute all videos
    recording = true;

    // set up the event to notify that all videos are ready for sending to servlet
    var dummyDiv = document.getElementById("dummyDiv");
    if(dummyDiv == null) {
        dummyDiv = document.createElement("div");
        dummyDiv.id = "dummyDiv";
        document.body.appendChild(dummyDiv);
    }
    dummyDiv.addEventListener('all_videos_ready', sendBlobsToServlet);
    // record local stream
    const options = {mimeType: 'video/webm'};
    localStreamRecorder = new MediaRecorder(localStream, options);
    localStreamRecorder.addEventListener('dataavailable', function(e) {
        if(e.data.size > 0) {
            localRecordedChunks.push(e.data);
        }
    });
    localStreamRecorder.addEventListener('stop', function() {
        blobsToSend[socketId] = new Blob(localRecordedChunks);
        console.log("conductor video size: ", blobsToSend[socketId].size);
        if(Object.keys(blobsToSend).length == Object.keys(connections).length) {
            console.log("all videos are ready (1): ", Object.keys(blobsToSend).length);
            var dummyDiv = document.getElementById("dummyDiv");
            dummyDiv.dispatchEvent(allVideosReadyEvent);
        }
    });
    localStreamRecorder.start();
}

function conductorStopRecording() {
    recording = false;
    // stop recording
    localStreamRecorder.stop();
    // TODO: stop indicating recording
    // TODO: unmute all videos
}

function receiveLocalVideo(fromId, buffer) {
    blobsToSend[fromId] = new Blob([buffer], {type: 'video/webm'});
    console.log("received local video from ", fromId, ": size = ", blobsToSend[fromId].size);
    if(Object.keys(blobsToSend).length == Object.keys(connections).length) {
        console.log("all videos are ready (2): ", Object.keys(blobsToSend).length);
        var dummyDiv = document.getElementById("dummyDiv");
        dummyDiv.dispatchEvent(allVideosReadyEvent);
    }
}

// send video data to Java through socket
function sendBlobsToServlet() {
    var dummyDiv = document.getElementById("dummyDiv");
    dummyDiv.addEventListener('prev_blob_sent', e => sendBlobToServlet(e.detail));
    dummyDiv.dispatchEvent(new CustomEvent('prev_blob_sent', {detail: 0}));
}

function sendBlobToServlet(index) {
    var ids = Object.keys(blobsToSend);
    if(index >= ids.length) return;
    console.log("sendBlobToServlet(", index, ")");
    var ws_url = "ws://localhost:" + videoSocketPort;
    var type = null;
    var name = null;
    // conductor
    if(ids[index] == socketId) {
        type = 'conductor';
        name = localName;
    }
    else {
        type = 'player';
        name = names[ids[index]];
    }
    console.log("sending blob from ", ids[index], ": type = ", type, ", name = ", name, ", size = ", blobsToSend[ids[index]].size);
    var ws = new WebSocket(ws_url);
    console.log("websocket created");
    ws.addEventListener('open', function(event) {
        console.log("opened");
        var msg = {
            name: name,
            id: ids[index],
            type: type,
        };
        ws.send(JSON.stringify(msg));

        blobsToSend[ids[index]].arrayBuffer().then(function(buffer) {
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
    var ids = Object.keys(connections);
    console.log("synchronizeVideos: ", videoSocketPort, ", ", Object.keys(connections).length, ", ", ids);
    $.ajax({
        type: "POST",
        url: "synchronize_videos",
        traditional: true,
        data: {
            port: videoSocketPort,
            ids: ids,
        },

        async: true,
        cache: false,
        timeout: 5000, // Timeout in ms

        success: function (data) {
            console.log("success");
	}
    });
}

// for players
// 1. Add syncAudioTrack to local stream if it doesn't have yet
// 2. Record local stream
// 3. Send the recorded blob to conductor via socket
function playerStartRecording() {
    const options = {mimeType: 'video/webm'};
    localStreamRecorder = new MediaRecorder(localStream, options);

    // 1. Add syncAudioTrack to local stream if it doesn't have yet
    var localAudioTracks = localStream.getAudioTracks();
    var conductorAudioTracks = conductorStream.getAudioTracks();
    for(var i=0; i<conductorAudioTracks.length; i++) {
        if(conductorAudioTracks[i].id == syncAudioTrackId) {
            if(localStream.getTrackById(syncAudioTrackId) == null) {
                var orgTracks = localStream.getAudioTracks();
                // copy the track to local video
                localStream.addTrack(conductorAudioTracks[i]);
                var newTracks = localStream.getAudioTracks();
                console.log("local audio track size: org = ", orgTracks.length, ", new = ", newTracks.length);
            }
        }
    }

    // 2. Record local stream
    localStreamRecorder.addEventListener('dataavailable', function(e) {
        if(e.data.size > 0) {
            localRecordedChunks.push(e.data);
        }
    });

    // 3. Send the recorded blob to conductor via socket
    localStreamRecorder.addEventListener('stop', function() {
        var blob = new Blob(localRecordedChunks);
        // send through socket
        console.log("sending local blob of size ", blob.size, " ...");
        blob.arrayBuffer().then(function(buffer) {
            console.log("buffer size: ", buffer.byteLength);
            socket.emit('local-blob', conductorId, buffer)
        });
        console.log("local done");
    });

    localStreamRecorder.start();
}

function startRecordingCommand() {
    // TODO: indicate recording
    // TODO: mute all videos
    recording = true;
    playerStartRecording();
}

function stopRecordingCommand() {
    recording = false;
    // stop recording
    localStreamRecorder.stop();
    // TODO: stop indicating recording
    // TODO: unmute all videos
}

function instantReplay(video, blob) {
    video.srcObject = null;
    video.src = URL.createObjectURL(blob);
    video.autoplay    = false;
    video.muted       = false;
    video.playsinline = true;
    video.controls    = true;
}

function startSession() {
}

function leave() {
    if(localStream) {
        localStream.getTracks().forEach(function(track) {
            track.stop();
        });
    }
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
    conductor = document.getElementById("conductorCheckbox").checked;
    if(conductor) {
        document.getElementById("conductorViewDiv").style.display = "block";
    }
    else {
        document.getElementById("playerViewDiv").style.display = "block";
    }
    localName = document.getElementById("nameText").value;
    console.log("joined: localName=" + localName + ", conductor=" + conductor);
    if('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices) {
        document.getElementById("joinButton").disabled = true;
        document.getElementById("leaveButton").disabled = false;

        if(conductor) {
            localVideo = document.getElementById("conductorViewLocalVideo");
        }
        else {
            localVideo = document.getElementById("playerViewLocalVideo");
        }
        localVideo.oncanplay = setupSocket;
        async function startStream() {
            try {
                const promise = await navigator.mediaDevices.getUserMedia(constraints);
                getUserMediaSuccess(promise);
            }
            catch(e) {
                console.log("getUserMedia failed: " + e);
            }
        }

        function getUserMediaSuccess(stream) {
            localStream = stream;
            var parent_div = localVideo.parentElement;
            var div_height = parent_div.getBoundingClientRect().height - textHeight;
            var div_width = parent_div.getBoundingClientRect().width;
            set_video_size(div_width, div_height, localVideo);
            localVideo.srcObject = stream;
            if(conductor) {
                document.getElementById("conductorViewLocalNameDiv").innerHTML = localName;
                // add audio stream for sync
                var audioContext = new AudioContext();
//                var oscillator = audioContext.createOscillator();
//                oscillator.frequency.value = 110;
                var streamAudioDestination = audioContext.createMediaStreamDestination();
//                oscillator.connect(streamAudioDestination);
//                oscillator.start();
                // add audio track from audiocontext
                var audioStream = streamAudioDestination.stream;
                var audioTracks = audioStream.getAudioTracks();
                var firstAudioTrack = audioTracks[0];
                console.log("new track id: ", firstAudioTrack.id);
                stream.addTrack(firstAudioTrack);
                syncAudioTrackId = firstAudioTrack.id;
            }
            else {
                document.getElementById("playerViewLocalNameDiv").innerHTML = localName;
            }
        }

        function setupSocket() {
            socket = io.connect(config.host, {secure: true});
//            socket = io.connect(config.host, {rejectUnauthorized: false, secure: true});
            socket.on('signal', gotMessageFromServer);
            socket.on('connect', onConnect);
            socket.on('local-blob', receiveLocalVideo);

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
                            connections[socketListId].addStream(localStream);
                            //send local name
                            socket.emit('signal', socketListId, JSON.stringify({'name': localName}));
                            // send conductor
                            if(conductor) {
                                socket.emit('signal', socketListId, JSON.stringify({'conductor': 'true'}));
                                // let everyone know syncAudioTrackId
                                Object.keys(connections).forEach(function(socketListId) {
                                    socket.emit('signal', socketListId, JSON.stringify({'sync': syncAudioTrackId}));
                                });
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
            console.log("gotRemoteStream: " + event + ", " + id);
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
                    conductorStream = event.stream;
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
    else {
        alert("Sorry, your browser does not support getUserMedia()");
    }

}

