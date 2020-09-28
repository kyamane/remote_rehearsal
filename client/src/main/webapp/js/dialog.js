'use strict';

var localVideo;
var localStream;
var socketId;
var connections = [];
var socket;
var localName;
var names = [];
var conductor = false;
var conductorId;

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
            console.log("parent_div: " + div_height + ", " + div_width);
            set_video_size(div_width, div_height, localVideo);
            localVideo.srcObject = stream;
            if(conductor) {
                document.getElementById("conductorViewLocalNameDiv").innerHTML = localName;
            }
            else {
                document.getElementById("playerViewLocalNameDiv").innerHTML = localName;
            }
            var audio = stream.getAudioTracks()[0];
            console.log(audio.getSettings());
        }

        function setupSocket() {
            console.log("host = " + config.host);
            socket = io.connect(config.host, {secure: true});
//            socket = io.connect(config.host, {rejectUnauthorized: false, secure: true});
            socket.on('signal', gotMessageFromServer);
            socket.on('connect', onConnect);

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
                    console.log("conductor display: " + p_height + ", " + p_width);
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
                    console.log("p_height: " + p_height + ", p_width: " + p_width + ", n_player_videos: " + n_player_videos + ", v_width: " + v_width);
                    set_video_size(v_width, p_height, video);
                }
            }
            div.appendChild(video);
            div.appendChild(nameDiv);
            parent_div.appendChild(div);
        }

        function gotMessageFromServer(fromId, message) {
            //Parse the incoming signal
            var signal = JSON.parse(message)
            //Make sure it's not coming from yourself
            if(fromId != socketId) {
//                console.log("gotMessageFromServer: " + fromId + ", " + message);
                console.log("gotMessageFromServer: " + fromId);
                if(signal.name) {
                    names[fromId] = signal.name;
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

        /////////////////////////////////////////
        startStream();
    }
    else {
        alert("Sorry, your browser does not support getUserMedia()");
    }
}
