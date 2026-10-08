// Elephant Memory: an endless conversation for the DeepSeek harness.
//
// The one export is the plugin the harness mounts (a service class as the
// default export, the form the harness's plugin guide names): a compaction
// service that starts every turn fresh from a fixed-size view of the whole
// history. The memory algorithm is Victor Taelin's OptChat specification:
// https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449

export { EndlessCompactionEngine as default } from './engine.js';
