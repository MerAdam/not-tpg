!((document,Drupal,$)=>{'use strict';Drupal.behaviors.infoTrafic={attach:function(context,settings){function initSummaryBlock($summaryBlock){$summaryBlock.find('.disruptions').html('');$summaryBlock.attr('uk-toggle',null);$summaryBlock.addClass('state-loading');}
function initFullBlock($fullBlock){$fullBlock.find('.disruptions').html('');}
function updateSummaryBlock($summaryBlock,disruptions,settings){let html='';if(disruptions.length>0){const maxDisruptions={bpSmall:2,bpMedium:13};let summarizedLinesData=disruptions.slice(0,Math.max(maxDisruptions.bpSmall,maxDisruptions.bpMedium));let classes=[];if(disruptions.length>maxDisruptions.bpSmall){classes.push('limit-reached-small');}
if(disruptions.length>maxDisruptions.bpMedium){classes.push('limit-reached-medium');}
html+='<ul class="'+classes.join(' ')+'">';for(let i in summarizedLinesData){let disruption=summarizedLinesData[i];html+=''+'<li>'+'<span class="'+disruption.style.classes+'" style="background-color: '+disruption.style.background+'">'+'<span>'+disruption.lineId+'</span>'+'</span>'+'</li>';}
if(disruptions.length>Math.min(maxDisruptions.bpSmall,maxDisruptions.bpMedium)){html+=''+'<li class="more">'+'<span>...</span>'+'</li>';}
html+='</ul>';}
else{html+=''+'<span class="no-disruption">'+Drupal.t('No disruption')+'</span>';}
$summaryBlock.find('.disruptions').html(html);$summaryBlock.removeClass('state-loading');if(disruptions.length>0){$summaryBlock.attr('uk-toggle','target: .info-trafic-bar--full');$summaryBlock.removeClass('state-no-disruption');}
else{$summaryBlock.addClass('state-no-disruption');}
$summaryBlock.removeClass('uk-hidden');}
function updateFullBlock($full,disruptions){$full.find('.disruptions').html(disruptions);}
function getDisruptions($summaryBlock,$fullBlock,settings){try{$.ajax({url:Drupal.url('getInfoTrafic'),cache:false,dataType:'json',success:function(response){initSummaryBlock($summaryBlock);initFullBlock($fullBlock);let data=response.disruptions_raw;if(!data||data.length<=0){updateSummaryBlock($summaryBlock,[],settings);if($fullBlock.attr('aria-hidden')==='false'&&typeof UIkit==='function'){UIkit.toggle('.info-trafic-bar--full').toggle();}
return;}
if(typeof data==='string'){data=JSON.parse(data);}
let disruptions=[];let lineIds=[];for(let i in data){let disruption=data[i];let lineId=disruption.line_id;if(lineIds.indexOf(lineId)<0){disruptions.push({lineId:lineId,style:disruption.style,time:disruption.time});lineIds.push(lineId);}}
updateSummaryBlock($summaryBlock,disruptions,settings);updateFullBlock($fullBlock,response.disruptions_full_html);}});}
catch(e){$summaryBlock.addClass('uk-hidden');return false;}}
const $elements=$(once('infoTrafic','.block-info-trafic',context));$elements.each(function(){if(typeof settings.infoTrafic==='undefined'){return;}
let $container=$(this);let $summaryBlock=$container.find('.info-trafic-bar--summary');if(!$summaryBlock.length){return;}
let $fullBlock=$container.find('.info-trafic-bar--full');if(!$fullBlock.length){return;}
$fullBlock.on('show',function(){$summaryBlock.attr('aria-hidden',true);});$fullBlock.on('hide',function(){$summaryBlock.attr('aria-hidden',false);});getDisruptions($summaryBlock,$fullBlock,settings.infoTrafic);if(typeof settings.infoTrafic.checkDelay!=='undefined'&&settings.infoTrafic.checkDelay>0){setInterval(function(){getDisruptions($summaryBlock,$fullBlock,settings.infoTrafic);},settings.infoTrafic.checkDelay*1000);}});}};})(document,Drupal,jQuery);